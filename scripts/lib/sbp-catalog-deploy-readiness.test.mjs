import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessSbpCatalogDeployReadiness as assess } from './sbp-catalog-deploy-readiness.mjs';

const digest = (character) => 'ghcr.io/kurt525/billok@sha256:' + character.repeat(64);
const fixture = () => ({
  publicationState: {
    firstReleasePublishedAndAccepted: true,
    catalogAutomationExplicitlyEnabled: true,
  },
  release: {
    mergedMainSha: 'a'.repeat(40),
    catalogOnlyMergeVerified: true,
    schemaChangesVerifiedAbsent: true,
  },
  current: {
    commitSha: 'b'.repeat(40),
    image: digest('c'),
    healthy: true,
    imageAvailableForRollback: true,
  },
  target: {
    commitSha: 'a'.repeat(40),
    image: digest('d'),
    imageBuildSmokePassed: true,
    imagePublished: true,
  },
  volumes: {
    before: { pgdata: 'billok_pgdata', uploads: 'billok_uploads' },
    after: { pgdata: 'billok_pgdata', uploads: 'billok_uploads' },
  },
  recovery: {
    backupVerified: true,
    rollbackProcedureVerified: true,
    failureEmailVerified: true,
    localHealthUrl: 'http://127.0.0.1:3000/api/health',
  },
});
const rejected = (change) => {
  const value = fixture();
  change(value);
  assert.equal(assess(value).ready, false);
};

describe('offline SBP catalog Docker deployment safety preflight', () => {
  it('defaults to DENY even with a published and smoke-tested image', () => {
    const value = fixture();
    delete value.publicationState;
    assert.equal(assess(value).ready, false);
    assert.equal(assess().ready, false);
    rejected((x) => (x.publicationState.firstReleasePublishedAndAccepted = false));
    rejected((x) => (x.publicationState.catalogAutomationExplicitlyEnabled = false));
  });
  it('requires exact main commit and guarantees no schema or code changes', () => {
    rejected((x) => (x.release.mergedMainSha = 'unknown'));
    rejected((x) => (x.release.catalogOnlyMergeVerified = false));
    rejected((x) => (x.release.schemaChangesVerifiedAbsent = false));
    rejected((x) => (x.target.commitSha = 'e'.repeat(40)));
  });
  it('requires immutable, smoke-tested images and a real rollback image', () => {
    rejected((x) => (x.target.image = 'ghcr.io/kurt525/billok:latest'));
    rejected((x) => (x.current.image = 'sharetab:latest'));
    rejected((x) => (x.target.image = x.current.image));
    rejected((x) => (x.target.imagePublished = false));
    rejected((x) => (x.target.imageBuildSmokePassed = false));
    rejected((x) => (x.current.healthy = false));
    rejected((x) => (x.current.imageAvailableForRollback = false));
  });
  it('protects existing data volumes and requires tested rollback and email', () => {
    rejected((x) => (x.volumes.after.pgdata = 'new_db'));
    rejected((x) => (x.volumes.after.uploads = 'new_uploads'));
    rejected((x) => (x.volumes.before.uploads = x.volumes.before.pgdata));
    rejected((x) => (x.recovery.backupVerified = false));
    rejected((x) => (x.recovery.rollbackProcedureVerified = false));
    rejected((x) => (x.recovery.failureEmailVerified = false));
    rejected((x) => (x.recovery.localHealthUrl = 'https://billok.ru/api/health'));
  });
  it('provides a nonexecuting release-and-rollback plan when ALL checks pass', () => {
    const value = fixture();
    assert.deepEqual(assess(value), {
      ready: true,
      targetImage: value.target.image,
      previousImage: value.current.image,
      expectedMainSha: value.release.mergedMainSha,
      requiredHealthUrl: value.recovery.localHealthUrl,
      preserveVolumes: value.volumes.before,
      mustCheckPublicSite: true,
      mustRollbackAndNotifyOnFailure: true,
      mustRecheckAllRuntimeFactsBeforeDeployment: true,
    });
  });
});
