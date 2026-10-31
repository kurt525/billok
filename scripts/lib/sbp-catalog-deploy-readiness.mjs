// Declarative OFFLINE safety plan. No Docker, GitHub or network operations.
// Runtime facts must later be verified by a trusted local deployment operator.
const SHA = /^[0-9a-f]{40}$/;
const IMAGE = /^ghcr\.io\/kurt525\/billok@sha256:[0-9a-f]{64}$/;
const LOCAL_HEALTH = /^http:\/\/127\.0\.0\.1:[0-9]{2,5}\/api\/health$/;

export function assessSbpCatalogDeployReadiness({
  publicationState,
  release,
  current,
  target,
  volumes,
  recovery,
} = {}) {
  const deny = (reason) => ({ ready: false, reason });
  if (
    publicationState?.firstReleasePublishedAndAccepted !== true ||
    publicationState?.catalogAutomationExplicitlyEnabled !== true
  ) {
    return deny('BillOK initial release is not accepted and automation is not explicitly enabled');
  }
  if (
    !SHA.test(release?.mergedMainSha || '') ||
    release?.catalogOnlyMergeVerified !== true ||
    release?.schemaChangesVerifiedAbsent !== true
  ) {
    return deny('Merged main commit and unchanged schema must be verified');
  }
  if (
    !SHA.test(current?.commitSha || '') ||
    !IMAGE.test(current?.image || '') ||
    current?.healthy !== true ||
    current?.imageAvailableForRollback !== true
  ) {
    return deny('A healthy immutable rollback image is required');
  }
  if (
    !IMAGE.test(target?.image || '') ||
    target.image === current.image ||
    target?.commitSha !== release.mergedMainSha ||
    target?.imageBuildSmokePassed !== true ||
    target?.imagePublished !== true
  ) {
    return deny('The new published immutable image must match the verified merge and pass smoke tests');
  }
  if (
    !volumes ||
    ![volumes.before?.pgdata, volumes.before?.uploads, volumes.after?.pgdata, volumes.after?.uploads].every(
      (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,120}$/.test(value),
    ) ||
    volumes.before.pgdata === volumes.before.uploads ||
    volumes.before.pgdata !== volumes.after.pgdata ||
    volumes.before.uploads !== volumes.after.uploads
  ) {
    return deny('Existing PostgreSQL and uploads volumes must be preserved exactly');
  }
  if (
    recovery?.backupVerified !== true ||
    recovery?.rollbackProcedureVerified !== true ||
    recovery?.failureEmailVerified !== true ||
    !LOCAL_HEALTH.test(recovery?.localHealthUrl || '')
  ) {
    return deny('Verified backup, rollback, failure email and local health checks are required');
  }
  // This plan is not proof the deployment has happened. The operator must
  // deploy the pinned image, check local and public health, and on failure
  // restore the pinned rollback image without discarding data volumes.
  return {
    ready: true,
    targetImage: target.image,
    previousImage: current.image,
    expectedMainSha: release.mergedMainSha,
    requiredHealthUrl: recovery.localHealthUrl,
    preserveVolumes: { ...volumes.before },
    mustCheckPublicSite: true,
    mustRollbackAndNotifyOnFailure: true,
    mustRecheckAllRuntimeFactsBeforeDeployment: true,
  };
}
