// Offline policy only. This file never merges, deploys or calls GitHub.
// A privileged publisher must re-read the current main/PR/CI state and use
// an exact expected commit SHA before any subsequent GitHub mutation.
export const REQUIRED_BILLOK_JOBS = Object.freeze([
  'Code quality and types',
  'Unit tests (Vitest)',
  'BillOK mobile PWA tests',
  'Mobile Chromium (320–720 px)',
  'Coverage regression (%)',
]);

const CATALOG_PATH = 'src/lib/sbp-bank-catalog.json';
const REPO = 'kurt525/billok';
const SHA_PATTERN = /^[0-9a-f]{40}$/;

// Release approval is supplied only by trusted, local deployment controls;
// never infer it from a GitHub PR, green CI, or an unchecked environment default.
export function assessSbpAutoPublish({ pr, files, run, jobs, mainSha, catalogValidatedSha, publicationState } = {}) {
  const refuse = (reason) => ({ allowed: false, reason });
  if (
    publicationState?.firstReleasePublishedAndAccepted !== true ||
    publicationState?.catalogAutomationExplicitlyEnabled !== true
  ) {
    return refuse(
      'Catalog automation is disabled until first production release is published, accepted and explicitly enabled',
    );
  }
  if (!SHA_PATTERN.test(mainSha || '') || !SHA_PATTERN.test(catalogValidatedSha || '')) {
    return refuse('Current main and catalog validation SHA must be verified');
  }
  if (
    pr?.state !== 'open' ||
    pr?.draft !== false ||
    pr?.base?.ref !== 'main' ||
    pr?.base?.repo?.full_name !== REPO ||
    pr?.head?.repo?.full_name !== REPO ||
    !/^billok\/sbp-catalog-\d{14}$/.test(pr?.head?.ref || '')
  ) {
    return refuse('Not a trusted open SBP-only proposal for main');
  }
  if (pr?.mergeable !== true || pr?.mergeable_state !== 'clean') {
    return refuse('Proposal is not safely mergeable');
  }
  if (pr?.base?.sha !== mainSha || !SHA_PATTERN.test(pr?.head?.sha || '') || pr?.head?.sha !== catalogValidatedSha) {
    return refuse('Proposal or main changed since catalog validation');
  }
  if (
    pr?.changed_files !== 1 ||
    !Array.isArray(files) ||
    files.length !== 1 ||
    files[0]?.filename !== CATALOG_PATH ||
    files[0]?.status !== 'modified'
  ) {
    return refuse('Proposal must modify only the bank catalog JSON');
  }
  if (
    run?.name !== 'BillOK CI' ||
    run?.event !== 'push' ||
    run?.head_repository?.full_name !== REPO ||
    run?.head_branch !== pr.head.ref ||
    run?.head_sha !== pr.head.sha ||
    run?.status !== 'completed' ||
    run?.conclusion !== 'success'
  ) {
    return refuse('No completed successful BillOK CI for the exact proposal commit');
  }
  if (!Array.isArray(jobs)) return refuse('CI jobs were not retrieved');
  const matched = new Set();
  for (const job of jobs) {
    if (!REQUIRED_BILLOK_JOBS.includes(job?.name)) continue;
    if (matched.has(job.name)) return refuse('Duplicate required CI jobs');
    matched.add(job.name);
    if (job.status !== 'completed' || job.conclusion !== 'success') {
      return refuse('A required CI job has not passed');
    }
  }
  if (matched.size !== REQUIRED_BILLOK_JOBS.length) {
    return refuse('Not all five required CI jobs have passed');
  }
  return { allowed: true, reason: 'All SBP-only PR and CI gates passed' };
}
