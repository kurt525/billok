import { assessSbpCatalogDeployReadiness } from './sbp-catalog-deploy-readiness.mjs';
import { planSbpCatalogRollback } from './sbp-catalog-rollback-plan.mjs';

// Future trusted adapter contract; no Docker, GitHub or SMTP imports.
// Deliberately not exported as a CLI or connected to any systemd unit.
// The adapter must lock the release and independently observe runtime facts.
// In particular, a successful CI, PR, or merge NEVER activates this runner.
const OPERATIONS = [
  'inspectBeforeDeploy',
  'deployPinnedImage',
  'inspectAfterDeploy',
  'restorePinnedImage',
  'inspectAfterRollback',
  'notifyFailure',
];

const sameVolumes = (expected, actual) => actual?.pgdata === expected.pgdata && actual?.uploads === expected.uploads;

export async function executeSbpCatalogDeployment({
  publicationState,
  release,
  current,
  target,
  volumes,
  recovery,
  adapter,
} = {}) {
  // Absolutely no adapter operations before fail-closed release approval.
  const preflight = assessSbpCatalogDeployReadiness({
    publicationState,
    release,
    current,
    target,
    volumes,
    recovery,
  });
  if (!preflight.ready) return { outcome: 'disabled-or-blocked', reason: preflight.reason };
  if (!adapter || !OPERATIONS.every((name) => typeof adapter[name] === 'function')) {
    return { outcome: 'disabled-or-blocked', reason: 'Trusted deployment adapter is missing an operation' };
  }

  const notify = async (stage) => {
    try {
      await adapter.notifyFailure({ stage, expectedMainSha: preflight.expectedMainSha });
      return 'sent';
    } catch {
      return 'failed';
    }
  };

  // The prepared plan alone is never enough: independently inspect the
  // running image, preserved volumes, health and release identity under lock.
  let before;
  try {
    before = await adapter.inspectBeforeDeploy();
  } catch {
    return { outcome: 'blocked', stage: 'pre-deploy-observation', notification: await notify('deployment') };
  }
  if (
    before?.runningImage !== preflight.previousImage ||
    before?.runningMainSha !== current.commitSha ||
    before?.expectedMainSha !== preflight.expectedMainSha ||
    before?.localHealthy !== true ||
    before?.publicHealthy !== true ||
    before?.rollbackImageAvailable !== true ||
    before?.backupVerified !== true ||
    before?.targetImageAvailable !== true ||
    !sameVolumes(preflight.preserveVolumes, before?.volumes)
  ) {
    return { outcome: 'blocked', stage: 'stale-pre-deploy-state', notification: await notify('deployment') };
  }

  // Exactly one deployment attempt, then either successful public and local
  // observations or exactly one recovery attempt. Never delete volumes.
  let after;
  let deploymentCommandFailed = false;
  try {
    await adapter.deployPinnedImage({ image: preflight.targetImage, preserveVolumes: preflight.preserveVolumes });
  } catch {
    deploymentCommandFailed = true;
  }
  // Even when the deployment command fails, its effects may have been
  // partially applied. Inspect once before deciding anything about rollback.
  try {
    after = await adapter.inspectAfterDeploy();
  } catch {
    return { outcome: 'escalated', stage: 'unobservable-deployment', notification: await notify('deployment') };
  }

  // Reject unknown images, missing health observations, and volume drift:
  // blindly rolling back these cases could destroy or overwrite user data.
  const decision = planSbpCatalogRollback({
    publicationState,
    deploymentPlan: preflight,
    observation: { ...after, phase: 'after-deploy' },
  });
  if (!decision.allowed) {
    return { outcome: 'escalated', stage: 'untrusted-post-deploy-state', notification: await notify('deployment') };
  }
  if (decision.action === 'release-healthy') {
    if (deploymentCommandFailed) {
      // A positive health probe cannot turn a failed deploy command into
      // verified success. Escalate, without risking an unnecessary rollback.
      return { outcome: 'escalated', stage: 'ambiguous-deployment-result', notification: await notify('deployment') };
    }
    return { outcome: 'deployed', image: preflight.targetImage };
  }
  if (decision.action !== 'restore-previous-image') {
    return { outcome: 'escalated', stage: 'unexpected-recovery-decision', notification: await notify('rollback') };
  }
  try {
    await adapter.restorePinnedImage({ image: decision.image, preserveVolumes: decision.preserveVolumes });
  } catch {
    return { outcome: 'escalated', stage: 'rollback-command-failed', notification: await notify('rollback') };
  }

  let recovered;
  try {
    recovered = await adapter.inspectAfterRollback();
  } catch {
    return { outcome: 'escalated', stage: 'rollback-health-unavailable', notification: await notify('rollback') };
  }
  const rollback = planSbpCatalogRollback({
    publicationState,
    deploymentPlan: preflight,
    observation: { ...recovered, phase: 'after-rollback' },
  });
  if (!rollback.allowed || rollback.action === 'escalate-rollback-failure') {
    return { outcome: 'escalated', stage: 'rollback-health-failed', notification: await notify('rollback') };
  }
  if (rollback.action === 'report-recovered-release-failure') {
    return {
      outcome: 'rolled-back',
      image: preflight.previousImage,
      notification: await notify('deployment'),
    };
  }
  return { outcome: 'escalated', stage: 'unexpected-rollback-decision', notification: await notify('rollback') };
}
