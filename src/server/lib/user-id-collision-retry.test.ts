import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { isUserIdCollision, retryUserIdCollision } from './user-id-collision-retry';

function unique(target: unknown, modelName: string = 'User') {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.0.0',
    meta: { modelName, target },
  });
}

describe('6.13.2: retry only real User.id collisions, never overwrite someone else', () => {
  it('retries the entire aborted transaction after a random User.id duplicate', async () => {
    const work = vi
      .fn()
      .mockRejectedValueOnce(unique(['id']))
      .mockResolvedValueOnce({ id: 'new-uuid' });
    await expect(retryUserIdCollision(work)).resolves.toEqual({ id: 'new-uuid' });
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('never retries duplicate user email or another model unique constraint', async () => {
    for (const error of [
      unique(['email']),
      unique(['id', 'email']),
      unique(['id'], 'Group'),
      unique('SystemInvite_code_key', 'SystemInvite'),
      new Error('Database unavailable'),
    ]) {
      const work = vi.fn().mockRejectedValue(error);
      await expect(retryUserIdCollision(work)).rejects.toBe(error);
      expect(work).toHaveBeenCalledOnce();
      expect(isUserIdCollision(error)).toBe(false);
    }
    expect(isUserIdCollision(unique('User_pkey'))).toBe(true);
    expect(isUserIdCollision(unique('User_id_key'))).toBe(true);
  });

  it('never loops indefinitely when the ID generator or PostgreSQL keeps failing', async () => {
    const error = unique(['id']);
    const work = vi.fn().mockRejectedValue(error);
    await expect(retryUserIdCollision(work)).rejects.toBe(error);
    expect(work).toHaveBeenCalledTimes(4); // one attempt and at most three retries
  });

  it('exposes no client-controlled ID, role or ownerId in its public API', () => {
    const source = String(retryUserIdCollision);
    expect(source).not.toContain('ownerId');
    expect(source).not.toContain('role');
    expect(source).not.toContain('userId:');
  });
});
