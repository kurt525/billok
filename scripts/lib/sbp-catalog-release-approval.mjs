import { constants } from 'node:fs';
import * as nodeFs from 'node:fs/promises';

// Read-only, fail-closed helper. Not attached to the poller, merge, Docker,
// a CLI or systemd. A future trusted adapter must hold an exclusive lock
// while calling this and while performing the guarded operation.
const APPROVAL_DIR = '/etc/billok';
const APPROVAL_FILE = '/etc/billok/sbp-catalog-release-approval';
const EXPECTED = 'firstReleasePublishedAndAccepted=true\ncatalogAutomationExplicitlyEnabled=true\n';

const denied = () => ({
  firstReleasePublishedAndAccepted: false,
  catalogAutomationExplicitlyEnabled: false,
});

function trustworthy(meta, kind) {
  return (
    meta?.uid === 0 &&
    Number.isInteger(meta.mode) &&
    (meta.mode & 0o022) === 0 &&
    (kind === 'directory' ? meta.isDirectory?.() === true : meta.isFile?.() === true) &&
    meta.isSymbolicLink?.() !== true
  );
}

function sameFile(a, b) {
  return (
    a?.dev === b?.dev &&
    a?.ino === b?.ino &&
    a?.uid === b?.uid &&
    a?.mode === b?.mode &&
    a?.size === b?.size &&
    a?.mtimeMs === b?.mtimeMs &&
    a?.ctimeMs === b?.ctimeMs
  );
}

function sameDirectory(a, b) {
  return a?.dev === b?.dev && a?.ino === b?.ino && a?.uid === b?.uid && a?.mode === b?.mode;
}

// Injecting fsOps is exclusively for offline unit tests; production must use
// the default real filesystem and never read approval from env or GitHub.
export async function readTrustedSbpReleaseApproval({ fsOps = nodeFs } = {}) {
  let handle;
  try {
    const directoryBefore = await fsOps.lstat(APPROVAL_DIR);
    if (!trustworthy(directoryBefore, 'directory')) return denied();

    const fileBefore = await fsOps.lstat(APPROVAL_FILE);
    if (!trustworthy(fileBefore, 'file') || fileBefore.size !== Buffer.byteLength(EXPECTED)) return denied();

    // O_NOFOLLOW protects against replacing the final path with a symlink.
    // O_NONBLOCK prevents waiting on an unexpected special file during open.
    handle = await fsOps.open(APPROVAL_FILE, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!trustworthy(opened, 'file') || !sameFile(fileBefore, opened)) return denied();

    const contents = await handle.readFile('utf8');
    const openedAfter = await handle.stat();
    const fileAfter = await fsOps.lstat(APPROVAL_FILE);
    const directoryAfter = await fsOps.lstat(APPROVAL_DIR);
    if (
      !trustworthy(openedAfter, 'file') ||
      !trustworthy(fileAfter, 'file') ||
      !trustworthy(directoryAfter, 'directory') ||
      !sameFile(opened, openedAfter) ||
      !sameFile(openedAfter, fileAfter) ||
      !sameDirectory(directoryBefore, directoryAfter) ||
      contents !== EXPECTED
    ) {
      return denied();
    }
    return { firstReleasePublishedAndAccepted: true, catalogAutomationExplicitlyEnabled: true };
  } catch {
    // Any inaccessible path, I/O error, permissions problem or race denies.
    return denied();
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
