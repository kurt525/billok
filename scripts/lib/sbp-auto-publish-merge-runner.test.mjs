import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { coordinateSbpCatalogMerge } from './sbp-auto-publish-merge-runner.mjs';
import { REQUIRED_BILLOK_JOBS } from './sbp-auto-publish-gate.mjs';

const path = 'repos/kurt525/billok';
const headSha = 'b'.repeat(40);
const mainSha = 'a'.repeat(40);
const branch = 'billok/sbp-catalog-20261030052000';
const approval = () => ({
  firstReleasePublishedAndAccepted: true,
  catalogAutomationExplicitlyEnabled: true,
});

function setup() {
  const calls = [];
  const pr = {
    number: 27,
    state: 'open',
    draft: false,
    base: { ref: 'main', sha: mainSha, repo: { full_name: 'kurt525/billok' } },
    head: { ref: branch, sha: headSha, repo: { full_name: 'kurt525/billok' } },
    changed_files: 1,
    mergeable: true,
    mergeable_state: 'clean',
  };
  const run = {
    id: 123,
    run_attempt: 1,
    name: 'BillOK CI',
    event: 'push',
    head_branch: branch,
    head_sha: headSha,
    head_repository: { full_name: 'kurt525/billok' },
    status: 'completed',
    conclusion: 'success',
  };
  const data = {
    [path + '/pulls/27']: pr,
    [path + '/branches/main']: { commit: { sha: mainSha } },
    [path + '/pulls/27/files?per_page=100']: [{ filename: 'src/lib/sbp-bank-catalog.json', status: 'modified' }],
    [path + '/actions/runs?head_sha=' + headSha + '&per_page=100']: { workflow_runs: [run] },
    [path + '/actions/runs/123/attempts/1/jobs?per_page=100']: {
      total_count: 5,
      jobs: REQUIRED_BILLOK_JOBS.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
    },
    [path + '/actions/runs/123']: run,
  };
  let approvalState = approval();
  const adapter = {
    async readReleaseApproval() {
      calls.push('approval');
      return approvalState;
    },
    async readGithub(url) {
      calls.push('get:' + url);
      assert.ok(Object.hasOwn(data, url), 'unexpected API path ' + url);
      return structuredClone(data[url]);
    },
    async validateCatalogAtSha(sha) {
      calls.push('catalog:' + sha);
      return {
        validatedSha: sha,
        trustedSourceVerified: true,
        stableBankIdsVerified: true,
        logosAndNamesVerified: true,
        suspiciousChangesAbsent: true,
      };
    },
    async verifyPublicationReadiness() {
      calls.push('readiness');
      return { safeDeployAndRollbackVerified: true, failureEmailVerified: true };
    },
    async submitShaPinnedMerge(request) {
      calls.push('merge');
      assert.equal(request.method, 'PUT');
      assert.equal(request.path, path + '/pulls/27/merge');
      assert.equal(request.body.sha, headSha);
      assert.equal(request.expectedMainSha, mainSha);
      assert.equal(request.expectedPrHeadSha, headSha);
      return { merged: true, sha: 'c'.repeat(40) };
    },
  };
  return {
    calls,
    data,
    adapter,
    setApproval: (state) => {
      approvalState = state;
    },
  };
}
const execute = (fixture) => coordinateSbpCatalogMerge({ prNumber: 27, adapter: fixture.adapter });
const countMerges = (fixture) => fixture.calls.filter((call) => call === 'merge').length;

describe('unconnected offline SBP auto-merge coordinator', () => {
  it('requires trusted approval BEFORE making any GitHub requests', async () => {
    const f = setup();
    f.setApproval({ firstReleasePublishedAndAccepted: false, catalogAutomationExplicitlyEnabled: true });
    assert.equal((await execute(f)).outcome, 'blocked');
    assert.deepEqual(f.calls, ['approval']);
    const g = setup();
    g.setApproval({ firstReleasePublishedAndAccepted: true, catalogAutomationExplicitlyEnabled: false });
    assert.equal((await execute(g)).outcome, 'blocked');
    assert.deepEqual(g.calls, ['approval']);
    assert.equal((await coordinateSbpCatalogMerge()).outcome, 'blocked');
  });
  it('makes exactly one SHA-pinned merge after two independent evidence reads', async () => {
    const f = setup();
    assert.deepEqual(await execute(f), {
      outcome: 'merged-awaiting-deployment',
      mergedMainSha: 'c'.repeat(40),
      deploymentStillRequired: true,
    });
    assert.equal(countMerges(f), 1);
    assert.equal(f.calls.filter((x) => x === 'catalog:' + headSha).length, 2);
    assert.equal(f.calls.filter((x) => x === 'approval').length, 2);
    assert.equal(f.calls.filter((x) => x.startsWith('get:')).length, 18);
    assert.equal(f.calls.at(-1), 'merge');
  });
  it('refuses untrusted bank catalog and missing deployment readiness', async () => {
    const f = setup();
    f.adapter.validateCatalogAtSha = async (sha) => ({
      validatedSha: sha,
      trustedSourceVerified: true,
      stableBankIdsVerified: true,
      logosAndNamesVerified: true,
      suspiciousChangesAbsent: false,
    });
    assert.equal((await execute(f)).outcome, 'blocked');
    assert.equal(countMerges(f), 0);
    const g = setup();
    g.adapter.verifyPublicationReadiness = async () => ({
      safeDeployAndRollbackVerified: true,
      failureEmailVerified: false,
    });
    assert.equal((await execute(g)).outcome, 'blocked');
    assert.equal(countMerges(g), 0);
  });
  it('rejects changed main, changed PR head, or newer failed CI between the two evidence reads', async () => {
    for (const mutate of [
      (f) => {
        f.data[path + '/branches/main'].commit.sha = 'd'.repeat(40);
      },
      (f) => {
        f.data[path + '/pulls/27'].head.sha = 'd'.repeat(40);
      },
      (f) => {
        f.data[path + '/actions/runs?head_sha=' + headSha + '&per_page=100'].workflow_runs[0].conclusion = 'failure';
      },
    ]) {
      const f = setup();
      const original = f.adapter.validateCatalogAtSha;
      let n = 0;
      f.adapter.validateCatalogAtSha = async (sha) => {
        n += 1;
        if (n === 1) mutate(f);
        return original(sha);
      };
      assert.equal((await execute(f)).outcome, 'blocked');
      assert.equal(countMerges(f), 0);
    }
  });
  it('fails closed if owner revokes automation after GitHub checks', async () => {
    const f = setup();
    const original = f.adapter.verifyPublicationReadiness;
    let n = 0;
    f.adapter.verifyPublicationReadiness = async () => {
      n += 1;
      if (n === 2) f.setApproval({ firstReleasePublishedAndAccepted: true, catalogAutomationExplicitlyEnabled: false });
      return original();
    };
    assert.equal((await execute(f)).outcome, 'blocked');
    assert.equal(countMerges(f), 0);
  });
  it('refuses missing or malformed adapter and GitHub evidence without attempting a merge', async () => {
    const f = setup();
    f.adapter.readGithub = async () => {
      throw new Error('private API token here');
    };
    assert.deepEqual(await execute(f), {
      outcome: 'blocked',
      reason: 'Verification failed or GitHub evidence unavailable',
    });
    assert.equal(countMerges(f), 0);
    const g = setup();
    delete g.adapter.validateCatalogAtSha;
    assert.equal((await execute(g)).outcome, 'blocked');
    assert.deepEqual(g.calls, []);
  });
  it('does not claim success or retry if the merge response is ambiguous or throws', async () => {
    const f = setup();
    f.adapter.submitShaPinnedMerge = async () => {
      f.calls.push('merge');
      throw new Error('transport timeout');
    };
    assert.deepEqual(await execute(f), { outcome: 'merge-status-unknown', needsOperatorReview: true });
    assert.equal(countMerges(f), 1);
    const g = setup();
    g.adapter.submitShaPinnedMerge = async () => {
      g.calls.push('merge');
      return { merged: false, sha: null };
    };
    assert.equal((await execute(g)).outcome, 'merge-status-unknown');
    assert.equal(countMerges(g), 1);
  });
});
