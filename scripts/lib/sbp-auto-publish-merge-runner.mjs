import { collectSbpPublishEvidence } from './sbp-auto-publish-evidence.mjs';
import { prepareSbpCatalogMerge } from './sbp-auto-publish-merge.mjs';

// Not wired to a CLI, systemd, GitHub writer or deployment. Future trusted
// operator supplies every operation. Nothing runs on module import.
const FUNCTIONS = [
  'readReleaseApproval',
  'readGithub',
  'validateCatalogAtSha',
  'verifyPublicationReadiness',
  'submitShaPinnedMerge',
];
const SHA = /^[0-9a-f]{40}$/;

function approved(state) {
  return state?.firstReleasePublishedAndAccepted === true && state?.catalogAutomationExplicitlyEnabled === true;
}

function sameEvidence(a, b) {
  return (
    a.mainSha === b.mainSha &&
    a.pr?.number === b.pr?.number &&
    a.pr?.head?.sha === b.pr?.head?.sha &&
    a.pr?.base?.sha === b.pr?.base?.sha &&
    a.pr?.head?.ref === b.pr?.head?.ref &&
    a.run?.id === b.run?.id &&
    a.run?.run_attempt === b.run?.run_attempt &&
    a.run?.status === b.run?.status &&
    a.run?.conclusion === b.run?.conclusion
  );
}

async function inspectCatalog(adapter, sha) {
  const result = await adapter.validateCatalogAtSha(sha);
  return (
    result?.validatedSha === sha &&
    result?.trustedSourceVerified === true &&
    result?.stableBankIdsVerified === true &&
    result?.logosAndNamesVerified === true &&
    result?.suspiciousChangesAbsent === true
  );
}

function readinessVerified(ready) {
  return ready?.safeDeployAndRollbackVerified === true && ready?.failureEmailVerified === true;
}

// Deliberately distinct from a deployed/succeeded status. A successful
// merge only means a new main commit exists and still needs publication.
export async function coordinateSbpCatalogMerge({ prNumber, adapter } = {}) {
  const deny = (reason) => ({ outcome: 'blocked', reason });
  if (
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1 ||
    !adapter ||
    !FUNCTIONS.every((f) => typeof adapter[f] === 'function')
  ) {
    return deny('Missing trusted merge adapter or proposal number');
  }
  let approval;
  try {
    // The privileged local adapter must derive this from the root-owned
    // release-approval file, never from GitHub or environment defaults.
    approval = await adapter.readReleaseApproval();
  } catch {
    return deny('Trusted release approval unavailable');
  }
  if (!approved(approval)) return deny('Initial release acceptance and separate automation approval required');

  try {
    const first = await collectSbpPublishEvidence(prNumber, adapter.readGithub);
    const sha = first.pr.head.sha;
    if (!(await inspectCatalog(adapter, sha))) return deny('Catalog validation or bank provenance failed');
    if (!readinessVerified(await adapter.verifyPublicationReadiness())) {
      return deny('Safe publication, rollback or failure email not independently verified');
    }
    // Re-check ALL trusted state immediately before the potential write.
    // A green earlier attempt, a moved main or new PR head cannot qualify.
    const latest = await collectSbpPublishEvidence(prNumber, adapter.readGithub);
    if (!sameEvidence(first, latest)) return deny('PR, main or latest CI changed during merge preparation');
    if (!(await inspectCatalog(adapter, sha))) return deny('Catalog validation became stale');
    if (!readinessVerified(await adapter.verifyPublicationReadiness())) {
      return deny('Deployment readiness changed during merge preparation');
    }
    const latestApproval = await adapter.readReleaseApproval();
    if (!approved(latestApproval)) return deny('Release authorization was revoked before merge');

    const merge = prepareSbpCatalogMerge(latest, {
      catalogValidatedSha: sha,
      publicationState: latestApproval,
      deploymentReadiness: {
        safeDeployAndRollbackVerified: true,
        failureEmailVerified: true,
      },
    });
    if (!merge.allowed || !merge.mustRecheckMainAndPrBeforeSending || !merge.mustVerifyPostMergeDeployment) {
      return deny(merge.reason || 'Unsafe merge request');
    }

    // One attempt only. The GitHub API has a SHA precondition for PR HEAD,
    // but not for BASE main. The future privileged adapter must enforce its
    // own main-branch freshness and concurrency lock at the actual write.
    let response;
    try {
      response = await adapter.submitShaPinnedMerge({
        ...merge.request,
        expectedMainSha: merge.expectedMainSha,
        expectedPrHeadSha: merge.expectedPrHeadSha,
      });
    } catch {
      // Unknown commit state after transport failure: NEVER blindly retry.
      return { outcome: 'merge-status-unknown', needsOperatorReview: true };
    }
    if (response?.merged !== true || !SHA.test(response?.sha || '')) {
      return { outcome: 'merge-status-unknown', needsOperatorReview: true };
    }
    return {
      outcome: 'merged-awaiting-deployment',
      mergedMainSha: response.sha,
      deploymentStillRequired: true,
    };
  } catch {
    // Do not leak credentials or untrusted GitHub responses in errors.
    return deny('Verification failed or GitHub evidence unavailable');
  }
}
