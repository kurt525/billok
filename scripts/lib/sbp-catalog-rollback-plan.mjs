// Pure offline recovery decisions. No Docker calls, network or email are sent.
// The trusted future deploy operator must verify observed runtime state itself.
const PINNED = /^ghcr\.io\/kurt525\/billok@sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const VOLUME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,120}$/;

export function planSbpCatalogRollback({ publicationState, deploymentPlan, observation } = {}) {
  const deny = (reason) => ({ allowed: false, reason });
  if (
    publicationState?.firstReleasePublishedAndAccepted !== true ||
    publicationState?.catalogAutomationExplicitlyEnabled !== true
  ) {
    return deny('Automatic bank publication is disabled until the first accepted release and explicit approval');
  }
  if (
    !PINNED.test(deploymentPlan?.targetImage || '') ||
    !PINNED.test(deploymentPlan?.previousImage || '') ||
    deploymentPlan.targetImage === deploymentPlan.previousImage ||
    !SHA.test(deploymentPlan?.expectedMainSha || '') ||
    deploymentPlan?.mustRollbackAndNotifyOnFailure !== true ||
    deploymentPlan?.mustRecheckAllRuntimeFactsBeforeDeployment !== true
  ) {
    return deny('Missing trusted immutable image and recovery plan');
  }
  const protectedVolumes = deploymentPlan.preserveVolumes;
  if (
    !VOLUME.test(protectedVolumes?.pgdata || '') ||
    !VOLUME.test(protectedVolumes?.uploads || '') ||
    protectedVolumes.pgdata === protectedVolumes.uploads ||
    observation?.volumes?.pgdata !== protectedVolumes.pgdata ||
    observation?.volumes?.uploads !== protectedVolumes.uploads
  ) {
    return deny('Runtime data volumes do not match the protected release');
  }
  if (typeof observation?.localHealthy !== 'boolean' || typeof observation?.publicHealthy !== 'boolean') {
    return deny('Local and public health observations must be explicit booleans');
  }
  if (observation.phase === 'after-deploy') {
    if (observation.runningImage !== deploymentPlan.targetImage) {
      return deny('Running image differs from the expected deployed image');
    }
    if (observation.localHealthy && observation.publicHealthy) {
      return { allowed: true, action: 'release-healthy', image: deploymentPlan.targetImage, sendFailureEmail: false };
    }
    // Restoring the old immutable image must preserve the existing DB/uploads.
    // This describes one guarded operation; it DOES NOT run it.
    return {
      allowed: true,
      action: 'restore-previous-image',
      image: deploymentPlan.previousImage,
      preserveVolumes: { ...protectedVolumes },
      requireLocalAndPublicHealthRecheck: true,
      requireFailureNotification: true,
    };
  }
  if (observation.phase === 'after-rollback') {
    if (observation.runningImage !== deploymentPlan.previousImage) {
      return {
        allowed: true,
        action: 'escalate-rollback-failure',
        reason: 'Expected rollback image was not restored',
        requireFailureNotification: true,
      };
    }
    if (observation.localHealthy && observation.publicHealthy) {
      return {
        allowed: true,
        action: 'report-recovered-release-failure',
        reason: 'The new release failed; the previous image is healthy',
        requireFailureNotification: true,
      };
    }
    return {
      allowed: true,
      action: 'escalate-rollback-failure',
      reason: 'Previous image restored but service health checks still fail',
      requireFailureNotification: true,
    };
  }
  return deny('Unknown deployment stage; operator investigation required');
}
