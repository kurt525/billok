import type { PrismaClient } from '@/generated/prisma/client';
import { AppError } from './app-error';
import { consumeOwnerPasskeyActionProof } from './owner-passkey-action-approval';
import { revokeAccountAuthenticationStateInTransaction } from './revoke-account-auth';

const FINGERPRINT = /^[a-f0-9]{64}$/u;
export const OWNER_PASSKEY_LABEL_MAX = 40;

function validateInput(input: { userId: string; sessionHash: string; targetId: string }) {
  if (!input.userId || !FINGERPRINT.test(input.sessionHash) || !input.targetId || input.targetId.length > 128)
    throw new AppError('FORBIDDEN');
}

export function normalizeOwnerPasskeyLabel(input: unknown): string {
  if (typeof input !== 'string') throw new AppError('BAD_REQUEST');
  const label = input.trim();
  // Empty labels, HTML control characters and bidi-format controls are
  // forbidden. React renders names as text, never injected HTML.
  if (!label || Array.from(label).length > OWNER_PASSKEY_LABEL_MAX || /[\p{Cc}\p{Cf}]/u.test(label))
    throw new AppError('BAD_REQUEST');
  return label;
}

export async function renameOwnerPasskey(input: {
  db: PrismaClient;
  userId: string;
  sessionHash: string;
  targetId: string;
  approvalToken: unknown;
  label: unknown;
  now?: Date;
}): Promise<{ renamed: true; label: string }> {
  validateInput(input);
  const label = normalizeOwnerPasskeyLabel(input.label);
  const now = input.now ?? new Date();
  return input.db.$transaction(async (tx) => {
    // Lock the user before consuming the one-time proof; recovery, revocation
    // and additional enrollment use the same lock order.
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', input.userId);
    const key = await tx.passkeyCredential.findUnique({ where: { id: input.targetId } });
    if (!key || key.userId !== input.userId || key.revokedAt) throw new AppError('FORBIDDEN');
    await consumeOwnerPasskeyActionProof(tx, {
      userId: input.userId,
      sessionHash: input.sessionHash,
      action: 'RENAME',
      targetId: input.targetId,
      approvalToken: input.approvalToken,
      now,
    });
    const changed = await tx.passkeyCredential.updateMany({
      where: { id: input.targetId, userId: input.userId, revokedAt: null },
      data: { label },
    });
    if (changed.count !== 1) throw new AppError('FORBIDDEN');
    await tx.adminAuditLog.create({
      data: {
        adminId: input.userId,
        action: 'OWNER_PASSKEY_RENAMED',
        metadata: { credentialRowId: input.targetId, labelChanged: true },
      },
    });
    return { renamed: true as const, label };
  });
}

export async function revokeApprovedOwnerPasskey(input: {
  db: PrismaClient;
  userId: string;
  sessionHash: string;
  targetId: string;
  approvalToken: unknown;
  now?: Date;
}): Promise<{ revoked: true; activeRemaining: number }> {
  validateInput(input);
  const now = input.now ?? new Date();
  return input.db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', input.userId);
    const [target, activeCount] = await Promise.all([
      tx.passkeyCredential.findUnique({ where: { id: input.targetId } }),
      tx.passkeyCredential.count({ where: { userId: input.userId, revokedAt: null } }),
    ]);
    if (!target || target.userId !== input.userId || target.revokedAt || activeCount < 2 || activeCount > 3)
      throw new AppError('FORBIDDEN');
    await consumeOwnerPasskeyActionProof(tx, {
      userId: input.userId,
      sessionHash: input.sessionHash,
      action: 'REVOKE',
      targetId: input.targetId,
      approvalToken: input.approvalToken,
      now,
    });
    const revoked = await tx.passkeyCredential.updateMany({
      where: { id: input.targetId, userId: input.userId, revokedAt: null },
      data: { revokedAt: now },
    });
    if (revoked.count !== 1) throw new AppError('FORBIDDEN');
    // Invalidate ALL pre-existing sessions (including those on the lost device).
    // All surviving keys remain active and can be used to sign in again.
    await revokeAccountAuthenticationStateInTransaction(tx, input.userId);
    await tx.adminAuditLog.create({
      data: {
        adminId: input.userId,
        action: 'OWNER_PASSKEY_REVOKED',
        metadata: {
          revokedCredentialRowId: input.targetId,
          activeRemaining: activeCount - 1,
          method: 'fresh-signed-owner-approval',
          previousSessionsRevoked: true,
        },
      },
    });
    return { revoked: true as const, activeRemaining: activeCount - 1 };
  });
}
