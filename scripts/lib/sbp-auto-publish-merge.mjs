import { assessSbpAutoPublish } from './sbp-auto-publish-gate.mjs';

// Pure request builder: NEVER performs GitHub calls, merges, builds, or deploys.
// A future privileged operator must re-read evidence and local release approval
// immediately before executing the SHA-pinned request, then verify deployment.
export function prepareSbpCatalogMerge(evidence, { publicationState, catalogValidatedSha, deploymentReadiness } = {}) {
  const deny = (reason) => ({ allowed: false, reason });
  // A passing CI alone cannot justify a merge that would trigger deployment.
  if (
    deploymentReadiness?.safeDeployAndRollbackVerified !== true ||
    deploymentReadiness?.failureEmailVerified !== true
  ) {
    return deny('Automated deployment, rollback and failure notification are not ready');
  }

  const check = assessSbpAutoPublish({ ...evidence, catalogValidatedSha, publicationState });
  if (!check.allowed) return deny(check.reason);

  const number = evidence?.pr?.number;
  if (!Number.isSafeInteger(number) || number < 1) return deny('Invalid proposal number');

  // Only the exact validated PR head may be merged. The GitHub merge endpoint
  // rejects a changed head if the sha precondition no longer matches.
  return {
    allowed: true,
    request: {
      method: 'PUT',
      path: 'repos/kurt525/billok/pulls/' + number + '/merge',
      body: {
        sha: catalogValidatedSha,
        merge_method: 'squash',
        commit_title: 'chore(billok): update verified SBP bank catalog',
      },
    },
    expectedMainSha: evidence.mainSha,
    expectedPrHeadSha: catalogValidatedSha,
    // This is ONLY a request plan, not proof that a merge or deploy succeeded.
    mustRecheckMainAndPrBeforeSending: true,
    mustVerifyPostMergeDeployment: true,
  };
}
