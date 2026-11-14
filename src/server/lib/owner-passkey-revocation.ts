import { createHash } from 'node:crypto';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import type { PrismaClient } from '@/generated/prisma/client';
import { AppError } from './app-error';
import { hashWebAuthnBinding } from './webauthn-registration';
import { readBillokWebAuthnRelyingParty, WEBAUTHN_CHALLENGE_TTL_MS } from './webauthn-relying-party';
import { revokeAccountAuthenticationStateInTransaction } from './revoke-account-auth';

export const OWNER_REVOKE_BINDING_COOKIE = 'billok-owner-key-revoke';
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
type Env = Readonly<Record<string, string | undefined>>;

function responseChallenge(response: AuthenticationResponseJSON): string {
  try {
    const data = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')) as {
      challenge?: unknown;
    };
    if (typeof data.challenge !== 'string' || !SECRET_PATTERN.test(data.challenge)) throw new Error('Invalid');
    return data.challenge;
  } catch {
    throw new AppError('FORBIDDEN');
  }
}

export async function beginOwnerPasskeyRevocation(input: {
  db: PrismaClient;
  ownerId: string;
  targetId: string;
  bindingSecret: string;
  env?: Env;
  now?: Date;
}) {
  if (!input.ownerId || !input.targetId || input.targetId.length > 128) throw new AppError('FORBIDDEN');
  const owner = await input.db.ownerBootstrap.findUnique({
    where: { id: 1 },
    select: { userId: true, completedAt: true },
  });
  if (!owner?.completedAt || owner.userId !== input.ownerId) throw new AppError('FORBIDDEN');
  const user = await input.db.user.findUnique({
    where: { id: input.ownerId },
    select: { emailVerified: true, suspendedAt: true, isPlaceholder: true },
  });
  if (!user?.emailVerified || user.suspendedAt || user.isPlaceholder) throw new AppError('FORBIDDEN');
  const active = await input.db.passkeyCredential.findMany({
    where: { userId: input.ownerId, revokedAt: null },
    select: { id: true, credentialId: true, transports: true },
    take: 4,
  });
  if (active.length < 2 || active.length > 3 || !active.some((key) => key.id === input.targetId)) {
    throw new AppError('FORBIDDEN');
  }
  const survivors = active.filter((key) => key.id !== input.targetId);
  const rp = readBillokWebAuthnRelyingParty(input.env ?? process.env);
  const options = await generateAuthenticationOptions({
    rpID: rp.rpId,
    userVerification: 'required',
    timeout: WEBAUTHN_CHALLENGE_TTL_MS,
    // The *lost* credential is explicitly excluded from the allowed signers.
    allowCredentials: survivors.map(({ credentialId, transports }) => ({
      id: credentialId,
      transports: transports as ('usb' | 'nfc' | 'ble' | 'internal' | 'hybrid')[],
    })),
  });
  const now = input.now ?? new Date();
  await input.db.webAuthnChallenge.create({
    data: {
      challengeHash: sha256(options.challenge),
      bindingHash: hashWebAuthnBinding(input.bindingSecret),
      purpose: 'OWNER_REVOKE',
      userId: input.ownerId,
      targetCredentialRowId: input.targetId,
      expiresAt: new Date(now.getTime() + WEBAUTHN_CHALLENGE_TTL_MS),
    },
  });
  return options;
}

export async function finishOwnerPasskeyRevocation(input: {
  db: PrismaClient;
  ownerId: string;
  bindingSecret: string;
  response: AuthenticationResponseJSON;
  env?: Env;
  now?: Date;
}): Promise<{ revoked: true; activeRemaining: number }> {
  if (!input.ownerId || typeof input.response.id !== 'string' || input.response.id.length > 512) {
    throw new AppError('FORBIDDEN');
  }
  const now = input.now ?? new Date();
  const challengeHash = sha256(responseChallenge(input.response));
  const bindingHash = hashWebAuthnBinding(input.bindingSecret);
  const challenge = await input.db.webAuthnChallenge.findUnique({ where: { challengeHash } });
  if (
    !challenge ||
    challenge.purpose !== 'OWNER_REVOKE' ||
    challenge.userId !== input.ownerId ||
    !challenge.targetCredentialRowId ||
    challenge.usedAt ||
    challenge.expiresAt <= now ||
    challenge.bindingHash !== bindingHash
  )
    throw new AppError('FORBIDDEN');
  const signer = await input.db.passkeyCredential.findUnique({
    where: { credentialId: input.response.id },
  });
  if (
    !signer ||
    signer.userId !== input.ownerId ||
    signer.revokedAt ||
    signer.id === challenge.targetCredentialRowId ||
    signer.signCount < 0 ||
    signer.signCount > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new AppError('FORBIDDEN');
  }
  const rp = readBillokWebAuthnRelyingParty(input.env ?? process.env);
  let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verified = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: (received) => sha256(received) === challengeHash,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserVerification: true,
      credential: {
        id: signer.credentialId,
        publicKey: new Uint8Array(signer.publicKey),
        counter: Number(signer.signCount),
        transports: signer.transports,
      },
    });
  } catch {
    throw new AppError('FORBIDDEN');
  }
  if (
    !verified.verified ||
    !verified.authenticationInfo.userVerified ||
    verified.authenticationInfo.credentialID !== signer.credentialId
  ) {
    throw new AppError('FORBIDDEN');
  }
  const nextCounter = verified.authenticationInfo.newCounter;
  if (
    !Number.isSafeInteger(nextCounter) ||
    nextCounter < 0 ||
    ((nextCounter !== 0 || signer.signCount !== BigInt(0)) && BigInt(nextCounter) <= signer.signCount)
  ) {
    throw new AppError('FORBIDDEN');
  }
  return input.db.$transaction(async (tx) => {
    // Lock the ACCOUNT before inspecting status and count; concurrent recovery
    // and revocations cannot both remove the final surviving Passkey.
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', input.ownerId);
    const [owner, user, target, actualSigner, activeCount] = await Promise.all([
      tx.ownerBootstrap.findUnique({ where: { id: 1 }, select: { userId: true, completedAt: true } }),
      tx.user.findUnique({
        where: { id: input.ownerId },
        select: { emailVerified: true, suspendedAt: true, isPlaceholder: true },
      }),
      tx.passkeyCredential.findUnique({ where: { id: challenge.targetCredentialRowId! } }),
      tx.passkeyCredential.findUnique({ where: { id: signer.id } }),
      tx.passkeyCredential.count({ where: { userId: input.ownerId, revokedAt: null } }),
    ]);
    if (
      !owner?.completedAt ||
      owner.userId !== input.ownerId ||
      !user?.emailVerified ||
      user.suspendedAt ||
      user.isPlaceholder ||
      activeCount < 2 ||
      activeCount > 3 ||
      !target ||
      target.userId !== input.ownerId ||
      target.revokedAt ||
      !actualSigner ||
      actualSigner.userId !== input.ownerId ||
      actualSigner.revokedAt ||
      actualSigner.id === target.id ||
      actualSigner.credentialId !== signer.credentialId ||
      actualSigner.signCount !== signer.signCount
    )
      throw new AppError('FORBIDDEN');
    const consumed = await tx.webAuthnChallenge.updateMany({
      where: {
        id: challenge.id,
        challengeHash,
        bindingHash,
        purpose: 'OWNER_REVOKE',
        userId: input.ownerId,
        targetCredentialRowId: target.id,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) throw new AppError('FORBIDDEN');
    const updatedSigner = await tx.passkeyCredential.updateMany({
      where: { id: signer.id, userId: input.ownerId, revokedAt: null, signCount: signer.signCount },
      data: {
        signCount: BigInt(nextCounter),
        lastUsedAt: now,
        deviceType: verified.authenticationInfo.credentialDeviceType,
        backedUp: verified.authenticationInfo.credentialBackedUp,
      },
    });
    if (updatedSigner.count !== 1) throw new AppError('FORBIDDEN');
    const revoked = await tx.passkeyCredential.updateMany({
      where: { id: target.id, userId: input.ownerId, revokedAt: null },
      data: { revokedAt: now },
    });
    if (revoked.count !== 1) throw new AppError('FORBIDDEN');
    // A stolen device might still hold a previously issued JWT. Revoke sessions,
    // not the other credentials: survivors can immediately sign in again.
    await revokeAccountAuthenticationStateInTransaction(tx, input.ownerId);
    await tx.adminAuditLog.create({
      data: {
        adminId: input.ownerId,
        action: 'OWNER_PASSKEY_REVOKED',
        metadata: {
          revokedCredentialRowId: target.id,
          verifiedCredentialRowId: signer.id,
          activeRemaining: activeCount - 1,
          previousSessionsRevoked: true,
        },
      },
    });
    return { revoked: true as const, activeRemaining: activeCount - 1 };
  });
}
