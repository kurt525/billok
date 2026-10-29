// Read-only GitHub evidence collector. This file cannot merge a PR, push,
// change a workflow, or deploy. External authentication is not required in tests.
const REPO_API = 'repos/kurt525/billok';

function requireObject(value, description) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Missing or invalid ' + description);
  }
  return value;
}

function requireArray(value, description) {
  if (!Array.isArray(value)) throw new Error('Missing or invalid ' + description);
  return value;
}

export async function collectSbpPublishEvidence(prNumber, getJson) {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1 || typeof getJson !== 'function') {
    throw new Error('Provide a valid PR number and read-only GitHub JSON getter');
  }

  const pr = requireObject(await getJson(REPO_API + '/pulls/' + prNumber), 'pull request');
  if (pr.number !== prNumber) throw new Error('GitHub returned an unexpected pull request');
  const headSha = pr.head?.sha;
  if (!/^[0-9a-f]{40}$/.test(headSha || '')) throw new Error('Missing PR head SHA');

  const main = requireObject(await getJson(REPO_API + '/branches/main'), 'main branch');
  const mainSha = main.commit?.sha;
  if (!/^[0-9a-f]{40}$/.test(mainSha || '')) throw new Error('Missing main SHA');

  // Include the entire file list only if the API independently confirms
  // exactly one changed file. Otherwise no unattended publisher may proceed.
  const files = requireArray(await getJson(REPO_API + '/pulls/' + prNumber + '/files?per_page=100'), 'changed files');
  if (files.length !== pr.changed_files) {
    throw new Error('Changed-file count does not agree with the pull request');
  }

  const runs = requireObject(
    await getJson(REPO_API + '/actions/runs?head_sha=' + headSha + '&per_page=100'),
    'workflow runs',
  );
  const candidates = requireArray(runs.workflow_runs, 'workflow runs').filter(
    (run) =>
      run.name === 'BillOK CI' &&
      run.event === 'push' &&
      run.head_sha === headSha &&
      run.head_branch === pr.head?.ref &&
      run.head_repository?.full_name === 'kurt525/billok',
  );
  // An old green run may NOT overrule a newer failed run of the same SHA.
  candidates.sort((a, b) => b.id - a.id);
  const run = candidates[0] || null;
  if (!run || !Number.isSafeInteger(run.id) || run.id < 1) {
    throw new Error('No BillOK CI run for the exact proposal head');
  }
  // A workflow run may have multiple attempts. Never accept jobs from an
  // earlier green attempt after a failed or still-running re-run. GitHub
  // provides a dedicated endpoint scoped to one exact run attempt.
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
    throw new Error('GitHub did not identify the workflow run attempt');
  }
  const runJobs = requireObject(
    await getJson(REPO_API + '/actions/runs/' + run.id + '/attempts/' + run.run_attempt + '/jobs?per_page=100'),
    'exact CI attempt jobs',
  );
  const jobs = requireArray(runJobs.jobs, 'exact CI attempt jobs');
  if (runJobs.total_count !== jobs.length) {
    throw new Error('Exact CI attempt jobs listing is incomplete');
  }

  // A new re-run can start while the jobs are being fetched. Check the run
  // AGAIN; if its attempt, conclusion or head changed, fail closed. A later
  // privileged merger must repeat the complete collector immediately before
  // any mutation, including checking for newer runs of the same head.
  const currentRun = requireObject(await getJson(REPO_API + '/actions/runs/' + run.id), 'current CI run');
  if (
    currentRun.id !== run.id ||
    currentRun.run_attempt !== run.run_attempt ||
    currentRun.head_sha !== run.head_sha ||
    currentRun.head_branch !== run.head_branch ||
    currentRun.status !== run.status ||
    currentRun.conclusion !== run.conclusion
  ) {
    throw new Error('CI run changed while checking the exact attempt');
  }

  // No publicationState or catalogValidatedSha is derived from GitHub. The
  // caller must verify deployment approval locally and revalidate the exact
  // catalog commit itself before even considering a merge.
  return { pr, files, run, jobs, mainSha };
}
