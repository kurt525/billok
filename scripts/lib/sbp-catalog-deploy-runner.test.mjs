import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeSbpCatalogDeployment as execute } from './sbp-catalog-deploy-runner.mjs';

const image = (char) => 'ghcr.io/kurt525/billok@sha256:' + char.repeat(64);
const volumeNames = () => ({ pgdata: 'billok_pgdata', uploads: 'billok_uploads' });
function setup() {
  const steps = [];
  const state = {
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
      image: image('c'),
      healthy: true,
      imageAvailableForRollback: true,
    },
    target: {
      commitSha: 'a'.repeat(40),
      image: image('d'),
      imageBuildSmokePassed: true,
      imagePublished: true,
    },
    volumes: { before: volumeNames(), after: volumeNames() },
    recovery: {
      backupVerified: true,
      rollbackProcedureVerified: true,
      failureEmailVerified: true,
      localHealthUrl: 'http://127.0.0.1:3000/api/health',
    },
  };
  state.adapter = {
    async inspectBeforeDeploy() {
      steps.push('before');
      return {
        runningImage: image('c'),
        runningMainSha: 'b'.repeat(40),
        expectedMainSha: 'a'.repeat(40),
        localHealthy: true,
        publicHealthy: true,
        rollbackImageAvailable: true,
        backupVerified: true,
        targetImageAvailable: true,
        volumes: volumeNames(),
      };
    },
    async deployPinnedImage(request) {
      steps.push('deploy');
      assert.deepEqual(request, { image: image('d'), preserveVolumes: volumeNames() });
    },
    async inspectAfterDeploy() {
      steps.push('after');
      return { runningImage: image('d'), localHealthy: true, publicHealthy: true, volumes: volumeNames() };
    },
    async restorePinnedImage(request) {
      steps.push('restore');
      assert.deepEqual(request, { image: image('c'), preserveVolumes: volumeNames() });
    },
    async inspectAfterRollback() {
      steps.push('verify-rollback');
      return { runningImage: image('c'), localHealthy: true, publicHealthy: true, volumes: volumeNames() };
    },
    async notifyFailure({ stage, expectedMainSha }) {
      steps.push('notify:' + stage);
      assert.equal(expectedMainSha, 'a'.repeat(40));
    },
  };
  return { state, steps };
}

describe('inert injected-operations SBP deployment coordinator', () => {
  it('does nothing before first site release and separate permission, even if everything else is green', async () => {
    for (const field of ['firstReleasePublishedAndAccepted', 'catalogAutomationExplicitlyEnabled']) {
      const { state, steps } = setup();
      state.publicationState[field] = false;
      assert.equal((await execute(state)).outcome, 'disabled-or-blocked');
      assert.deepEqual(steps, []);
    }
    assert.equal((await execute()).outcome, 'disabled-or-blocked');
  });
  it('requires an adapter with every operation before any read or write', async () => {
    const { state } = setup();
    state.adapter = {
      deployPinnedImage() {
        throw new Error('must not execute');
      },
    };
    assert.equal((await execute(state)).outcome, 'disabled-or-blocked');
  });
  it('deploys exactly once with success and never mails or rolls back', async () => {
    const { state, steps } = setup();
    assert.deepEqual(await execute(state), { outcome: 'deployed', image: image('d') });
    assert.deepEqual(steps, ['before', 'deploy', 'after']);
  });
  it('blocks stale image, health or data volumes before a single deployment action', async () => {
    for (const modify of [
      (x) => (x.runningImage = image('f')),
      (x) => (x.localHealthy = false),
      (x) => (x.volumes.pgdata = 'different_db'),
      (x) => (x.backupVerified = false),
      (x) => (x.targetImageAvailable = false),
    ]) {
      const { state, steps } = setup();
      const before = state.adapter.inspectBeforeDeploy;
      state.adapter.inspectBeforeDeploy = async () => {
        const result = await before();
        modify(result);
        return result;
      };
      assert.deepEqual(await execute(state), {
        outcome: 'blocked',
        stage: 'stale-pre-deploy-state',
        notification: 'sent',
      });
      assert.deepEqual(steps, ['before', 'notify:deployment']);
    }
  });
  it('restores the pinned image ONCE after failed public health, preserves volumes and alerts', async () => {
    const { state, steps } = setup();
    const after = state.adapter.inspectAfterDeploy;
    state.adapter.inspectAfterDeploy = async () => ({ ...(await after()), publicHealthy: false });
    assert.deepEqual(await execute(state), { outcome: 'rolled-back', image: image('c'), notification: 'sent' });
    assert.deepEqual(steps, ['before', 'deploy', 'after', 'restore', 'verify-rollback', 'notify:deployment']);
  });
  it('escalates failed rollback, never retries and does not report success', async () => {
    const { state, steps } = setup();
    const after = state.adapter.inspectAfterDeploy;
    state.adapter.inspectAfterDeploy = async () => ({ ...(await after()), localHealthy: false });
    state.adapter.restorePinnedImage = async () => {
      steps.push('restore');
      throw new Error('secret should not be leaked');
    };
    assert.deepEqual(await execute(state), {
      outcome: 'escalated',
      stage: 'rollback-command-failed',
      notification: 'sent',
    });
    assert.deepEqual(steps, ['before', 'deploy', 'after', 'restore', 'notify:rollback']);
  });
  it('does not roll back into unknown current image or modified database volume', async () => {
    for (const modify of [
      (x) => (x.runningImage = image('e')),
      (x) => (x.volumes.uploads = 'replacement_uploads'),
      (x) => (x.publicHealthy = undefined),
    ]) {
      const { state, steps } = setup();
      const after = state.adapter.inspectAfterDeploy;
      state.adapter.inspectAfterDeploy = async () => {
        const result = await after();
        modify(result);
        return result;
      };
      assert.deepEqual(await execute(state), {
        outcome: 'escalated',
        stage: 'untrusted-post-deploy-state',
        notification: 'sent',
      });
      assert.deepEqual(steps, ['before', 'deploy', 'after', 'notify:deployment']);
    }
  });
  it('observes a partial failure after a thrown deploy and safely rolls back if image is known', async () => {
    const { state, steps } = setup();
    state.adapter.deployPinnedImage = async () => {
      steps.push('deploy');
      throw new Error('temporary Docker error');
    };
    const after = state.adapter.inspectAfterDeploy;
    state.adapter.inspectAfterDeploy = async () => ({ ...(await after()), publicHealthy: false });
    assert.equal((await execute(state)).outcome, 'rolled-back');
    assert.deepEqual(steps, ['before', 'deploy', 'after', 'restore', 'verify-rollback', 'notify:deployment']);
  });
  it('never calls a thrown deployment successful just because the health probe looks good', async () => {
    const { state, steps } = setup();
    state.adapter.deployPinnedImage = async () => {
      steps.push('deploy');
      throw new Error('failed command');
    };
    assert.deepEqual(await execute(state), {
      outcome: 'escalated',
      stage: 'ambiguous-deployment-result',
      notification: 'sent',
    });
    assert.deepEqual(steps, ['before', 'deploy', 'after', 'notify:deployment']);
  });
  it('escalates unobservable partial deployment instead of blindly rolling back', async () => {
    const { state, steps } = setup();
    state.adapter.deployPinnedImage = async () => {
      steps.push('deploy');
      throw new Error('failed');
    };
    state.adapter.inspectAfterDeploy = async () => {
      steps.push('after');
      throw new Error('health probe failed');
    };
    assert.deepEqual(await execute(state), {
      outcome: 'escalated',
      stage: 'unobservable-deployment',
      notification: 'sent',
    });
    assert.deepEqual(steps, ['before', 'deploy', 'after', 'notify:deployment']);
  });
  it('escalates rollback probe failures, even if the rollback command succeeded', async () => {
    const { state, steps } = setup();
    const after = state.adapter.inspectAfterDeploy;
    state.adapter.inspectAfterDeploy = async () => ({ ...(await after()), publicHealthy: false });
    state.adapter.inspectAfterRollback = async () => {
      steps.push('verify-rollback');
      throw new Error('timeout');
    };
    assert.deepEqual(await execute(state), {
      outcome: 'escalated',
      stage: 'rollback-health-unavailable',
      notification: 'sent',
    });
    assert.deepEqual(steps, ['before', 'deploy', 'after', 'restore', 'verify-rollback', 'notify:rollback']);
  });
  it('never reports delivery if even the injected failure notification fails', async () => {
    const { state, steps } = setup();
    state.adapter.inspectBeforeDeploy = async () => {
      steps.push('before');
      throw new Error('missing state');
    };
    state.adapter.notifyFailure = async () => {
      steps.push('notify:deployment');
      throw new Error('SMTP secrets');
    };
    assert.deepEqual(await execute(state), {
      outcome: 'blocked',
      stage: 'pre-deploy-observation',
      notification: 'failed',
    });
  });
});
