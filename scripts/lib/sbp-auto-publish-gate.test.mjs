import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessSbpAutoPublish, REQUIRED_BILLOK_JOBS } from './sbp-auto-publish-gate.mjs';

const mainSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const valid = () => ({
  mainSha,
  catalogValidatedSha: headSha,
  pr: {
    state: 'open',
    draft: false,
    base: { ref: 'main', sha: mainSha, repo: { full_name: 'kurt525/billok' } },
    head: {
      ref: 'billok/sbp-catalog-20261029052000',
      sha: headSha,
      repo: { full_name: 'kurt525/billok' },
    },
    changed_files: 1,
    mergeable: true,
    mergeable_state: 'clean',
  },
  files: [{ filename: 'src/lib/sbp-bank-catalog.json', status: 'modified' }],
  run: {
    name: 'BillOK CI',
    event: 'push',
    head_branch: 'billok/sbp-catalog-20261029052000',
    head_sha: headSha,
    head_repository: { full_name: 'kurt525/billok' },
    status: 'completed',
    conclusion: 'success',
  },
  jobs: REQUIRED_BILLOK_JOBS.map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
  })),
});
const rejected = (change) => {
  const value = valid();
  change(value);
  assert.equal(assessSbpAutoPublish(value).allowed, false);
};

describe('strict unattended SBP auto-publication eligibility', () => {
  it('only approves a checked single-file catalog change with all five passing jobs', () => {
    assert.deepEqual(assessSbpAutoPublish(valid()), {
      allowed: true,
      reason: 'All SBP-only PR and CI gates passed',
    });
  });
  it('rejects missing current refs and unverified catalog snapshot', () => {
    rejected((x) => (x.mainSha = ''));
    rejected((x) => (x.catalogValidatedSha = ''));
    rejected((x) => (x.catalogValidatedSha = 'c'.repeat(40)));
    rejected((x) => (x.mainSha = 'c'.repeat(40)));
  });
  it('rejects manual PRs, forks, closed or draft PRs', () => {
    rejected((x) => (x.pr.head.ref = 'billok/01-mobile-pwa-foundation'));
    rejected((x) => (x.pr.head.ref = 'billok/sbp-catalog-malicious'));
    rejected((x) => (x.pr.head.repo.full_name = 'attacker/billok'));
    rejected((x) => (x.pr.state = 'closed'));
    rejected((x) => (x.pr.draft = true));
    rejected((x) => (x.pr.base.ref = 'something-other-than-main'));
  });
  it('rejects conflicts and changes to anything beyond catalog JSON', () => {
    rejected((x) => (x.pr.mergeable = null));
    rejected((x) => (x.pr.mergeable_state = 'unstable'));
    rejected((x) => (x.pr.changed_files = 2));
    rejected((x) => x.files.push({ filename: '.github/workflows/billok-ci.yml', status: 'modified' }));
    rejected((x) => (x.files[0].filename = 'src/lib/other.json'));
    rejected((x) => (x.files[0].status = 'removed'));
  });
  it('rejects stale, incomplete and failed CI reports', () => {
    rejected((x) => (x.run.head_sha = 'd'.repeat(40)));
    rejected((x) => (x.run.head_branch = 'main'));
    rejected((x) => (x.run.event = 'pull_request'));
    rejected((x) => (x.run.name = 'Other workflow'));
    rejected((x) => (x.run.status = 'queued'));
    rejected((x) => (x.run.conclusion = 'failure'));
    rejected((x) => (x.jobs[0].conclusion = 'failure'));
    rejected((x) => (x.jobs[0].status = 'in_progress'));
    rejected((x) => x.jobs.pop());
    rejected((x) => x.jobs.push({ ...x.jobs[0] }));
  });
});
