import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { logger } from './logger';
import releaseManifest from './billok-release.json';

export interface ReleaseInfo {
  taskId: string;
  taskTitle: string;
  pullRequest: number;
}

interface BuildInfo {
  version: string;
  commitSha: string;
  release: ReleaseInfo | null;
}

let cached: BuildInfo | null = null;

export function getBuildInfo(): BuildInfo {
  if (cached) return cached;

  let version = 'unknown';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'));
    version = pkg.version;
  } catch (error) {
    logger.warn('build-info.version.failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let commitSha = 'unknown';
  try {
    commitSha = fs.readFileSync(path.resolve(process.cwd(), '.commit-sha'), 'utf-8').trim();
  } catch {
    if (process.env.NODE_ENV !== 'test') {
      try {
        commitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim();
      } catch (error) {
        logger.warn('build-info.commitSha.failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  cached = { version, commitSha, release: parseReleaseInfo(releaseManifest, version) };
  return cached;
}

// Compiled into the server bundle, so the metadata travels with the exact image.
// A version mismatch must never associate a different task with this release.
export function parseReleaseInfo(value: unknown, version: string): ReleaseInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (
    entry.schemaVersion !== 1 ||
    !/^[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version) ||
    entry.version !== version ||
    typeof entry.taskId !== 'string' ||
    !/^TASK-BILLOK-\d{3,}$/u.test(entry.taskId) ||
    typeof entry.taskTitle !== 'string' ||
    !entry.taskTitle.trim() ||
    entry.taskTitle.length > 200 ||
    typeof entry.pullRequest !== 'number' ||
    !Number.isSafeInteger(entry.pullRequest) ||
    entry.pullRequest < 1
  )
    return null;
  return { taskId: entry.taskId, taskTitle: entry.taskTitle, pullRequest: entry.pullRequest };
}

export function parseDeploymentDate(value: unknown, build: Pick<BuildInfo, 'version' | 'commitSha'>): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (
    entry.schemaVersion !== 1 ||
    !/^[a-f0-9]{40}$/u.test(build.commitSha) ||
    entry.commitSha !== build.commitSha ||
    entry.version !== build.version ||
    !/^[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(build.version) ||
    typeof entry.deployedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(entry.deployedAt)
  )
    return null;
  const date = new Date(entry.deployedAt);
  return Number.isFinite(date.getTime()) && date.toISOString() === entry.deployedAt && date.getTime() <= Date.now()
    ? entry.deployedAt
    : null;
}

// A root-controlled deployment receipt is written only AFTER successful health
// and private/public probes. Read at query time (not at startup): confirmation
// can arrive after the container is already running. Never infer from mtime,
// image creation, process start or GitHub. Missing/stale evidence is not a date.
export function getDeploymentDate(build: Pick<BuildInfo, 'version' | 'commitSha'>): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      path.resolve(process.cwd(), '.billok-deployment.json'),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 4096) return null;
    const buffer = Buffer.alloc(4097);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > 4096) return null;
    return parseDeploymentDate(JSON.parse(buffer.subarray(0, length).toString('utf8')), build);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
