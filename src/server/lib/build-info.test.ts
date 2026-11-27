import fs from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { getDeploymentDate, parseDeploymentDate, parseReleaseInfo } from './build-info';

const sha = 'a'.repeat(40);
const build = { version: '1.1.0', commitSha: sha };
const marker = { schemaVersion: 1, ...build, deployedAt: '2020-01-02T03:04:05.123Z' };
const release = {
  schemaVersion: 1,
  version: '1.1.0',
  taskId: 'TASK-BILLOK-008',
  taskTitle: 'Переработка панели',
  pullRequest: 33,
};

afterEach(() => vi.restoreAllMocks());

describe('release identity belongs to the compiled version', () => {
  it('returns only valid task and PR metadata', () => {
    expect(parseReleaseInfo(release, '1.1.0')).toEqual({
      taskId: 'TASK-BILLOK-008',
      taskTitle: 'Переработка панели',
      pullRequest: 33,
    });
    expect(parseReleaseInfo(release, '1.0.0')).toBeNull();
    expect(parseReleaseInfo(null, '1.1.0')).toBeNull();
  });
  it.each([
    { schemaVersion: 2 },
    { taskId: 'invalid' },
    { taskTitle: ' ' },
    { pullRequest: 0 },
    { pullRequest: '33' },
    { pullRequest: 1.5 },
  ])('rejects invalid manifest: %j', (invalid) => {
    expect(parseReleaseInfo({ ...release, ...invalid }, '1.1.0')).toBeNull();
  });
});

describe('confirmed deployment date', () => {
  it('is accepted for the exact installed SHA and version', () => {
    expect(parseDeploymentDate(marker, build)).toBe(marker.deployedAt);
    expect(parseDeploymentDate(marker, { ...build, commitSha: 'b'.repeat(40) })).toBeNull();
    expect(parseDeploymentDate(marker, { ...build, version: '1.0.0' })).toBeNull();
    expect(parseDeploymentDate(marker, { ...build, commitSha: 'unknown' })).toBeNull();
    expect(parseDeploymentDate({ ...marker, commitSha: 'aaaaaaa' }, { ...build, commitSha: 'aaaaaaa' })).toBeNull();
  });
  it.each([
    {},
    null,
    { ...marker, schemaVersion: 2 },
    { ...marker, deployedAt: 'invalid' },
    { ...marker, deployedAt: '2020-02-31T03:04:05.123Z' },
    { ...marker, deployedAt: '2999-01-01T00:00:00.000Z' },
    { ...marker, deployedAt: '2020-01-02T03:04:05Z' },
  ])('rejects missing or unconfirmed dates: %j', (invalid) => {
    expect(parseDeploymentDate(invalid, build)).toBeNull();
  });
  it('does not cache a missing receipt at startup or a different SHA after rollback', () => {
    const open = vi
      .spyOn(fs, 'openSync')
      .mockImplementationOnce(() => {
        throw new Error('missing');
      })
      .mockReturnValue(42);
    vi.spyOn(fs, 'fstatSync').mockReturnValue({ isFile: () => true, uid: 0, mode: 0o100644, size: 150 } as fs.Stats);
    const read = vi.spyOn(fs, 'readSync').mockImplementation((_fd, buffer) => {
      const bytes = Buffer.from(JSON.stringify(marker));
      bytes.copy(buffer as Buffer);
      return bytes.length;
    });
    const close = vi.spyOn(fs, 'closeSync').mockImplementation(() => {});
    expect(getDeploymentDate(build)).toBeNull();
    expect(getDeploymentDate(build)).toBe(marker.deployedAt);
    expect(getDeploymentDate(build)).toBe(marker.deployedAt);
    expect(getDeploymentDate({ ...build, commitSha: 'b'.repeat(40) })).toBeNull();
    expect(open).toHaveBeenCalledTimes(4);
    expect(read).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(3);
  });
  it.each([{ uid: 1001 }, { mode: 0o100666 }, { size: 4097 }, { isFile: () => false }])(
    'rejects unsafe receipt file: %j',
    (unsafe) => {
      vi.spyOn(fs, 'openSync').mockReturnValue(42);
      vi.spyOn(fs, 'fstatSync').mockReturnValue({
        isFile: () => true,
        uid: 0,
        mode: 0o100644,
        size: 150,
        ...unsafe,
      } as fs.Stats);
      const read = vi.spyOn(fs, 'readSync');
      vi.spyOn(fs, 'closeSync').mockImplementation(() => {});
      expect(getDeploymentDate(build)).toBeNull();
      expect(read).not.toHaveBeenCalled();
    },
  );
});
