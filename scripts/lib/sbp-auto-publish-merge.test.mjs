import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REQUIRED_BILLOK_JOBS } from './sbp-auto-publish-gate.mjs';
import { prepareSbpCatalogMerge } from './sbp-auto-publish-merge.mjs';

const mainSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
function valid() {
  const branch = 'billok/sbp-catalog-20261029120000';
  return {
    evidence: {
      mainSha,
      pr: {
        number: 17,
        state: 'open',
        draft: false,
        base: { ref: 'main', sha: mainSha, repo: { full_name: 'kurt525/billok' } },
        head: { ref: branch, sha: headSha, repo: { full_name: 'kurt525/billok' } },
        mergeable: true,
        mergeable_state: 'clean',
        changed_files: 1,
      },
      files: [{ filename: 'src/lib/sbp-bank-catalog.json', status: 'modified' }],
      run: {
        name: 'BillOK CI',
        event: 'push',
        head_branch: branch,
        head_sha: headSha,
        head_repository: { full_name: 'kurt525/billok' },
        status: 'completed',
        conclusion: 'success',
      },
      jobs: REQUIRED_BILLOK_JOBS.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
    },
    options: {
      catalogValidatedSha: headSha,
      publicationState: {
        firstReleasePublishedAndAccepted: true,
        catalogAutomationExplicitlyEnabled: true,
      },
      deploymentReadiness: {
        safeDeployAndRollbackVerified: true,
        failureEmailVerified: true,
      },
    },
  };
}
const rejected = (change) => {
  const fixture = valid();
  change(fixture);
  assert.equal(prepareSbpCatalogMerge(fixture.evidence, fixture.options).allowed, false);
};

describe('offline SHA-pinned SBP bank catalog merge preparation', () => {
  it('defaults to DENY before first site launch, even for green CI', () => {
    const fixture = valid();
    assert.equal(prepareSbpCatalogMerge(fixture.evidence).allowed, false);
    delete fixture.options.publicationState;
    assert.equal(prepareSbpCatalogMerge(fixture.evidence, fixture.options).allowed, false);
    assert.equal(prepareSbpCatalogMerge().allowed, false);
  });
  it('refuses to merge until rollback AND failed-update email are verified', () => {
    rejected((x) => delete x.options.deploymentReadiness);
    rejected((x) => (x.options.deploymentReadiness.safeDeployAndRollbackVerified = false));
    rejected((x) => (x.options.deploymentReadiness.failureEmailVerified = false));
    rejected((x) => (x.options.deploymentReadiness.failureEmailVerified = 'true'));
  });
  it('builds a SHA-pinned single-file merge request without executing it', () => {
    const fixture = valid();
    const result = prepareSbpCatalogMerge(fixture.evidence, fixture.options);
    assert.deepEqual(result, {
      allowed: true,
      request: {
        method: 'PUT',
        path: 'repos/kurt525/billok/pulls/17/merge',
        body: {
          sha: headSha,
          merge_method: 'squash',
          commit_title: 'chore(billok): update verified SBP bank catalog',
        },
      },
      expectedMainSha: mainSha,
      expectedPrHeadSha: headSha,
      mustRecheckMainAndPrBeforeSending: true,
      mustVerifyPostMergeDeployment: true,
    });
  });
  it('refuses changed SHA, missing jobs, other files or conflicting PRs', () => {
    rejected((x) => (x.options.catalogValidatedSha = 'c'.repeat(40)));
    rejected((x) => (x.evidence.mainSha = 'd'.repeat(40)));
    rejected((x) => (x.evidence.pr.number = 0));
    rejected((x) => (x.evidence.pr.mergeable_state = 'dirty'));
    rejected((x) => (x.evidence.files[0].filename = '.github/workflows/billok-ci.yml'));
    rejected((x) => (x.evidence.jobs[0].conclusion = 'failure'));
    rejected((x) => (x.options.publicationState.catalogAutomationExplicitlyEnabled = false));
  });
});
