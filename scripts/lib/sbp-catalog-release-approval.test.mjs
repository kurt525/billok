import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { describe, it } from 'node:test';
import { readTrustedSbpReleaseApproval } from './sbp-catalog-release-approval.mjs';

const EXPECTED = 'firstReleasePublishedAndAccepted=true\ncatalogAutomationExplicitlyEnabled=true\n';
const DIR = '/etc/billok';
const FILE = '/etc/billok/sbp-catalog-release-approval';
const APPROVED = { firstReleasePublishedAndAccepted: true, catalogAutomationExplicitlyEnabled: true };
const DENIED = { firstReleasePublishedAndAccepted: false, catalogAutomationExplicitlyEnabled: false };

function stat(kind, overrides = {}) {
  return {
    dev: 1,
    ino: kind === 'directory' ? 10 : 20,
    uid: 0,
    mode: kind === 'directory' ? 0o40755 : 0o100600,
    size: kind === 'file' ? Buffer.byteLength(EXPECTED) : 0,
    mtimeMs: 100,
    ctimeMs: 100,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
    ...overrides,
  };
}

function fixture() {
  const calls = [];
  const state = {
    directory: stat('directory'),
    file: stat('file'),
    opened: null,
    contents: EXPECTED,
    failPath: null,
    afterDirectory: null,
    afterFile: null,
    afterOpened: null,
  };
  const reads = { directory: 0, file: 0, opened: 0 };
  const fsOps = {
    async lstat(path) {
      calls.push('lstat:' + path);
      if (state.failPath === path) throw new Error('read denied');
      if (path === DIR) return ++reads.directory === 1 ? state.directory : (state.afterDirectory ?? state.directory);
      if (path === FILE) return ++reads.file === 1 ? state.file : (state.afterFile ?? state.file);
      throw new Error('Unexpected path');
    },
    async open(path, flags) {
      calls.push('open:' + path);
      assert.equal(path, FILE);
      assert.ok((flags & constants.O_NOFOLLOW) !== 0);
      assert.ok((flags & constants.O_NONBLOCK) !== 0);
      return {
        async stat() {
          calls.push('stat');
          return ++reads.opened === 1 ? (state.opened ?? state.file) : (state.afterOpened ?? state.file);
        },
        async readFile(encoding) {
          calls.push('readFile');
          assert.equal(encoding, 'utf8');
          return state.contents;
        },
        async close() {
          calls.push('close');
        },
      };
    },
  };
  return { fsOps, state, calls };
}
const read = (f) => readTrustedSbpReleaseApproval({ fsOps: f.fsOps });

describe('read-only root-owned bank release approval', () => {
  it('accepts only exact two-line root-owned approval and closes the handle', async () => {
    const f = fixture();
    assert.deepEqual(await read(f), APPROVED);
    assert.deepEqual(f.calls, [
      'lstat:' + DIR, 'lstat:' + FILE, 'open:' + FILE,
      'stat', 'readFile', 'stat', 'lstat:' + FILE, 'lstat:' + DIR, 'close',
    ]);
  });

  it('fails closed for missing or unreadable directory or file', async () => {
    for (const path of [DIR, FILE]) {
      const f = fixture();
      f.state.failPath = path;
      assert.deepEqual(await read(f), DENIED);
      assert.equal(f.calls.includes('readFile'), false);
    }
  });

  it('rejects non-root ownership and group/other-writable permissions', async () => {
    for (const property of ['directory', 'file']) {
      for (const change of [{ uid: 1000 }, { mode: property === 'directory' ? 0o40775 : 0o100666 }]) {
        const f = fixture();
        f.state[property] = stat(property, change);
        assert.deepEqual(await read(f), DENIED);
        assert.equal(f.calls.includes('open:' + FILE), false);
      }
    }
  });

  it('denies symlinks and special files before open', async () => {
    for (const property of ['directory', 'file']) {
      const f = fixture();
      f.state[property] = stat('symlink');
      assert.deepEqual(await read(f), DENIED);
      assert.equal(f.calls.includes('open:' + FILE), false);
    }
    const special = fixture();
    special.state.file = stat('socket');
    assert.deepEqual(await read(special), DENIED);
  });

  it('rejects extra content, wrong flags and missing newline', async () => {
    for (const content of [EXPECTED + 'extra=true\n', EXPECTED.replace('true', 'false'), EXPECTED.trimEnd()]) {
      const f = fixture();
      f.state.contents = content;
      assert.deepEqual(await read(f), DENIED);
      assert.equal(f.calls.at(-1), 'close');
    }
  });

  it('rejects replaced file between lstat and open', async () => {
    const f = fixture();
    f.state.opened = stat('file', { ino: 42 });
    assert.deepEqual(await read(f), DENIED);
    assert.equal(f.calls.includes('readFile'), false);
    assert.equal(f.calls.at(-1), 'close');
  });

  it('rejects changes to the file during reading, even if content is still approved', async () => {
    for (const change of [{ mtimeMs: 101 }, { ino: 22 }, { uid: 1000 }]) {
      const f = fixture();
      f.state.afterFile = stat('file', change);
      assert.deepEqual(await read(f), DENIED);
    }
  });

  it('rejects directory replacement or permissions changes during reading', async () => {
    for (const change of [{ ino: 11 }, { mode: 0o40777 }, { uid: 1000 }]) {
      const f = fixture();
      f.state.afterDirectory = stat('directory', change);
      assert.deepEqual(await read(f), DENIED);
    }
  });

  it('rejects overlarge approval files without opening them', async () => {
    const f = fixture();
    f.state.file = stat('file', { size: 10000 });
    assert.deepEqual(await read(f), DENIED);
    assert.equal(f.calls.includes('open:' + FILE), false);
  });

  it('rejects failures in file-handle operations and never writes or executes commands', async () => {
    const f = fixture();
    f.fsOps.open = async () => { throw new Error('O_NOFOLLOW rejected'); };
    assert.deepEqual(await read(f), DENIED);
    assert.deepEqual(Object.keys(f.fsOps).sort(), ['lstat', 'open']);
  });
});
