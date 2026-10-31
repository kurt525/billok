import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planSbpCatalogRollback } from './sbp-catalog-rollback-plan.mjs';

const image = (char) => 'ghcr.io/kurt525/billok@sha256:' + char.repeat(64);
function scenario() {
  const volumes = { pgdata: 'billok_pgdata', uploads: 'billok_uploads' };
  return {
    publicationState: {
      firstReleasePublishedAndAccepted: true,
      catalogAutomationExplicitlyEnabled: true,
    },
    deploymentPlan: {
      targetImage: image('a'),
      previousImage: image('b'),
      expectedMainSha: 'c'.repeat(40),
      preserveVolumes: volumes,
      mustRollbackAndNotifyOnFailure: true,
      mustRecheckAllRuntimeFactsBeforeDeployment: true,
    },
    observation: {
      phase: 'after-deploy',
      runningImage: image('a'),
      localHealthy: true,
      publicHealthy: true,
      volumes: { ...volumes },
    },
  };
}
const rejected = (change) => {
  const data = scenario();
  change(data);
  assert.equal(planSbpCatalogRollback(data).allowed, false);
};
describe('offline fail-closed recovery of an unsuccessful SBP-only deployment', () => {
  it('blocks all decisions before initial publication and explicit enablement', () => {
    assert.equal(planSbpCatalogRollback().allowed, false);
    rejected((x) => (x.publicationState.firstReleasePublishedAndAccepted = false));
    rejected((x) => (x.publicationState.catalogAutomationExplicitlyEnabled = false));
    rejected((x) => (x.publicationState = undefined));
  });
  it('never rolls back when the new site is healthy', () => {
    assert.deepEqual(planSbpCatalogRollback(scenario()), {
      allowed: true,
      action: 'release-healthy',
      image: image('a'),
      sendFailureEmail: false,
    });
  });
  it('plans the pinned previous image for local OR public failure without touching volumes', () => {
    for (const field of ['localHealthy', 'publicHealthy']) {
      const data = scenario();
      data.observation[field] = false;
      assert.deepEqual(planSbpCatalogRollback(data), {
        allowed: true,
        action: 'restore-previous-image',
        image: image('b'),
        preserveVolumes: { pgdata: 'billok_pgdata', uploads: 'billok_uploads' },
        requireLocalAndPublicHealthRecheck: true,
        requireFailureNotification: true,
      });
    }
  });
  it('rejects unverified image, altered data volumes and ambiguous health observations', () => {
    rejected((x) => (x.deploymentPlan.targetImage = 'sharetab:latest'));
    rejected((x) => (x.deploymentPlan.previousImage = x.deploymentPlan.targetImage));
    rejected((x) => (x.deploymentPlan.expectedMainSha = 'not-a-sha'));
    rejected((x) => (x.deploymentPlan.mustRollbackAndNotifyOnFailure = false));
    rejected((x) => (x.observation.runningImage = image('d')));
    rejected((x) => (x.observation.volumes.pgdata = 'new_pgdata'));
    rejected((x) => (x.observation.volumes.uploads = 'new_uploads'));
    rejected((x) => (x.observation.localHealthy = undefined));
    rejected((x) => (x.observation.publicHealthy = 'healthy'));
    rejected((x) => (x.observation.phase = 'unknown'));
  });
  it('requires alert on recovered rollback and escalates broken rollback without destructive retries', () => {
    const data = scenario();
    data.observation.phase = 'after-rollback';
    data.observation.runningImage = image('b');
    assert.deepEqual(planSbpCatalogRollback(data), {
      allowed: true,
      action: 'report-recovered-release-failure',
      reason: 'The new release failed; the previous image is healthy',
      requireFailureNotification: true,
    });
    data.observation.localHealthy = false;
    const stillBroken = planSbpCatalogRollback(data);
    assert.equal(stillBroken.action, 'escalate-rollback-failure');
    assert.equal(stillBroken.requireFailureNotification, true);
    data.observation.localHealthy = true;
    data.observation.runningImage = image('d');
    assert.equal(planSbpCatalogRollback(data).action, 'escalate-rollback-failure');
  });
});
