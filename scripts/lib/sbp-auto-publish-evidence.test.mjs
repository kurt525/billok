import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectSbpPublishEvidence } from './sbp-auto-publish-evidence.mjs';
import { assessSbpAutoPublish, REQUIRED_BILLOK_JOBS } from './sbp-auto-publish-gate.mjs';

const mainSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const path = 'repos/kurt525/billok';
const branch = 'billok/sbp-catalog-20261029120000';

function responses() {
  return {
    [path + '/pulls/17']: {
      number: 17,
      state: 'open',
      draft: false,
      base: { ref: 'main', sha: mainSha, repo: { full_name: 'kurt525/billok' } },
      head: { ref: branch, sha: headSha, repo: { full_name: 'kurt525/billok' } },
      mergeable: true,
      mergeable_state: 'clean',
      changed_files: 1,
    },
    [path + '/branches/main']: { commit: { sha: mainSha } },
    [path + '/pulls/17/files?per_page=100']: [{ filename: 'src/lib/sbp-bank-catalog.json', status: 'modified' }],
    [path + '/actions/runs?head_sha=' + headSha + '&per_page=100']: {
      workflow_runs: [
        {
          id: 100,
          run_attempt: 1,
          name: 'BillOK CI',
          event: 'push',
          head_sha: headSha,
          head_branch: branch,
          head_repository: { full_name: 'kurt525/billok' },
          status: 'completed',
          conclusion: 'success',
        },
      ],
    },
    [path + '/actions/runs/100/attempts/1/jobs?per_page=100']: {
      total_count: 5,
      jobs: REQUIRED_BILLOK_JOBS.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
    },
    [path + '/actions/runs/100']: {
      id: 100,
      run_attempt: 1,
      head_sha: headSha,
      head_branch: branch,
      status: 'completed',
      conclusion: 'success',
    },
  };
}
function fixture(data) {
  const queried = [];
  const getJson = async (url) => {
    queried.push(url);
    assert.ok(Object.hasOwn(data, url), 'unexpected GitHub request: ' + url);
    return data[url];
  };
  return { getJson, queried };
}

describe('read-only SBP publication GitHub evidence', () => {
  it('collects the latest exact CI run and all five jobs without making write requests', async () => {
    const { getJson, queried } = fixture(responses());
    const evidence = await collectSbpPublishEvidence(17, getJson);
    assert.equal(evidence.run.id, 100);
    assert.equal(evidence.mainSha, mainSha);
    assert.equal(evidence.files.length, 1);
    assert.equal(evidence.jobs.length, 5);
    assert.equal(queried.length, 6);
    assert.ok(queried.every((url) => url.startsWith(path + '/')));
    // Even with a successful CI, missing first-release approval denies.
    assert.equal(assessSbpAutoPublish({ ...evidence, catalogValidatedSha: headSha }).allowed, false);
  });
  it('selects the newest same-head run, even when it failed', async () => {
    const data = responses();
    const key = path + '/actions/runs?head_sha=' + headSha + '&per_page=100';
    data[key].workflow_runs.unshift({ ...data[key].workflow_runs[0], id: 101, conclusion: 'failure' });
    data[path + '/actions/runs/101/attempts/1/jobs?per_page=100'] =
      data[path + '/actions/runs/100/attempts/1/jobs?per_page=100'];
    data[path + '/actions/runs/101'] = {
      ...data[path + '/actions/runs/100'],
      id: 101,
      conclusion: 'failure',
    };
    const evidence = await collectSbpPublishEvidence(17, fixture(data).getJson);
    assert.equal(evidence.run.id, 101);
    assert.equal(
      assessSbpAutoPublish({
        ...evidence,
        catalogValidatedSha: headSha,
        publicationState: {
          firstReleasePublishedAndAccepted: true,
          catalogAutomationExplicitlyEnabled: true,
        },
      }).allowed,
      false,
    );
  });
  it('rejects wrong PR data or incomplete lists rather than guessing', async () => {
    await assert.rejects(collectSbpPublishEvidence(0, async () => ({})));
    const wrong = responses();
    wrong[path + '/pulls/17'].number = 99;
    await assert.rejects(collectSbpPublishEvidence(17, fixture(wrong).getJson), /unexpected/);

    const files = responses();
    files[path + '/pulls/17'].changed_files = 2;
    await assert.rejects(collectSbpPublishEvidence(17, fixture(files).getJson), /count/);

    const jobs = responses();
    jobs[path + '/actions/runs/100/attempts/1/jobs?per_page=100'].total_count = 6;
    await assert.rejects(collectSbpPublishEvidence(17, fixture(jobs).getJson), /incomplete/);
  });
  it('uses only the CURRENT attempt, never a previous green CI attempt', async () => {
    const data = responses();
    const runsKey = path + '/actions/runs?head_sha=' + headSha + '&per_page=100';
    data[runsKey].workflow_runs[0].run_attempt = 2;
    data[runsKey].workflow_runs[0].conclusion = 'failure';
    data[path + '/actions/runs/100'] = {
      ...data[path + '/actions/runs/100'],
      run_attempt: 2,
      conclusion: 'failure',
    };
    data[path + '/actions/runs/100/attempts/2/jobs?per_page=100'] = {
      total_count: 1,
      jobs: [{ name: 'Mobile Chromium (320–720 px)', status: 'completed', conclusion: 'failure' }],
    };
    const { getJson, queried } = fixture(data);
    const evidence = await collectSbpPublishEvidence(17, getJson);
    assert.equal(evidence.run.run_attempt, 2);
    assert.ok(queried.some((url) => url.includes('/attempts/2/jobs?per_page=100')));
    assert.equal(
      assessSbpAutoPublish({
        ...evidence,
        catalogValidatedSha: headSha,
        publicationState: {
          firstReleasePublishedAndAccepted: true,
          catalogAutomationExplicitlyEnabled: true,
        },
      }).allowed,
      false,
    );
  });
  it('refuses a new CI rerun started during the evidence read', async () => {
    const data = responses();
    data[path + '/actions/runs/100'].run_attempt = 2;
    data[path + '/actions/runs/100'].status = 'in_progress';
    data[path + '/actions/runs/100'].conclusion = null;
    await assert.rejects(collectSbpPublishEvidence(17, fixture(data).getJson), /changed while checking/);
  });
  it('fails closed for missing attempt number instead of accepting unscoped jobs', async () => {
    const data = responses();
    delete data[path + '/actions/runs?head_sha=' + headSha + '&per_page=100'].workflow_runs[0].run_attempt;
    await assert.rejects(collectSbpPublishEvidence(17, fixture(data).getJson), /did not identify/);
  });
  it('fails closed when CI is missing or belongs to a different branch', async () => {
    const missing = responses();
    const key = path + '/actions/runs?head_sha=' + headSha + '&per_page=100';
    missing[key].workflow_runs[0].head_branch = 'main';
    await assert.rejects(collectSbpPublishEvidence(17, fixture(missing).getJson), /No BillOK CI run/);
  });
});
