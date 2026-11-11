import { createHash } from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import { AppError } from './app-error';
import { hashWebAuthnBinding } from './webauthn-registration';
import { OWNER_BOOTSTRAP_SINGLETON_ID } from './owner-bootstrap';
import {
  readBillokWebAuthnRelyingParty,
  WEBAUTHN_CHALLENGE_TTL_MS,
  WEBAUTHN_PASSKEY_POLICY,
} from './webauthn-relying-party';

export const OWNER_BACKUP_BINDING_COOKIE = 'billok-owner-backup-passkey';
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export async function beginOwnerBackupPasskey(input: {
  db: PrismaClient;
  userId: string;
  bindingSecret: string;
  now?: Date;
  env?: Readonly<Record<string, string | undefined>>;
}) {
  const now = input.now ?? new Date();
  const owner = await input.db.ownerBootstrap.findUnique({
    where: { id: OWNER_BOOTSTRAP_SINGLETON_ID },
    select: { userId: true, completedAt: true },
  });
  if (!owner || owner.userId !== input.userId || owner.completedAt) throw new AppError('FORBIDDEN');
  const user = await input.db.user.findUnique({
    where: { id: input.userId },
    select: {
      email: true,
      name: true,
      emailVerified: true,
      suspendedAt: true,
      webAuthnUserHandle: true,
      passkeyCredentials: {
        where: { revokedAt: null },
        select: { credentialId: true, transports: true },
        take: 3,
      },
    },
  });
  if (!user?.emailVerified || user.suspendedAt || !user.webAuthnUserHandle || user.passkeyCredentials.length !== 1)
    throw new AppError('FORBIDDEN');
  const rp = readBillokWebAuthnRelyingParty(input.env ?? process.env);
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpId,
    userID: new Uint8Array(Buffer.from(user.webAuthnUserHandle, 'base64url')),
    userName: user.email,
    userDisplayName: user.name ?? user.email,
    timeout: WEBAUTHN_CHALLENGE_TTL_MS,
    attestationType: WEBAUTHN_PASSKEY_POLICY.attestationType,
    authenticatorSelection: {
      residentKey: WEBAUTHN_PASSKEY_POLICY.residentKey,
      userVerification: WEBAUTHN_PASSKEY_POLICY.userVerification,
    },
    excludeCredentials: user.passkeyCredentials.map((key) => ({
      id: key.credentialId,
      transports: key.transports,
    })),
  });
  await input.db.webAuthnChallenge.create({
    data: {
      userId: input.userId,
      purpose: 'ADD_KEY',
      challengeHash: hash(options.challenge),
      bindingHash: hashWebAuthnBinding(input.bindingSecret),
      expiresAt: new Date(now.getTime() + WEBAUTHN_CHALLENGE_TTL_MS),
    },
  });
  return options;
}

function responseChallenge(response: RegistrationResponseJSON) {
  try {
    const json = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')) as {
      challenge?: unknown;
    };
    if (typeof json.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(json.challenge)) {
      throw new Error('Invalid challenge');
    }
    return json.challenge;
  } catch {
    throw new AppError('FORBIDDEN');
  }
}

export async function finishOwnerBackupPasskey(input: {
  db: PrismaClient;
  userId: string;
  bindingSecret: string;
  response: RegistrationResponseJSON;
  now?: Date;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<{ completed: true }> {
  const now = input.now ?? new Date();
  const challengeHash = hash(responseChallenge(input.response));
  const bindingHash = hashWebAuthnBinding(input.bindingSecret);
  const challenge = await input.db.webAuthnChallenge.findUnique({ where: { challengeHash } });
  if (
    !challenge ||
    challenge.userId !== input.userId ||
    challenge.purpose !== 'ADD_KEY' ||
    challenge.usedAt ||
    challenge.expiresAt <= now ||
    challenge.bindingHash !== bindingHash
  )
    throw new AppError('FORBIDDEN');

  const rp = readBillokWebAuthnRelyingParty(input.env ?? process.env);
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: (received) => hash(received) === challenge.challengeHash,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserPresence: true,
      requireUserVerification: true,
    });
  } catch {
    throw new AppError('FORBIDDEN');
  }
  if (!verified.verified || !verified.registrationInfo.userVerified) throw new AppError('FORBIDDEN');
  const { credential, credentialDeviceType, credentialBackedUp, aaguid } = verified.registrationInfo;
  try {
    await input.db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', input.userId);
      const [owner, user] = await Promise.all([
        tx.ownerBootstrap.findUnique({ where: { id: OWNER_BOOTSTRAP_SINGLETON_ID } }),
        tx.user.findUnique({
          where: { id: input.userId },
          select: {
            emailVerified: true,
            suspendedAt: true,
            webAuthnUserHandle: true,
            passkeyCredentials: { where: { revokedAt: null }, select: { id: true, credentialId: true }, take: 3 },
          },
        }),
      ]);
      if (
        !owner ||
        owner.userId !== input.userId ||
        owner.completedAt ||
        !user?.emailVerified ||
        user.suspendedAt ||
        !user.webAuthnUserHandle ||
        user.passkeyCredentials.length !== 1 ||
        user.passkeyCredentials.some((item) => item.credentialId === credential.id)
      )
        throw new AppError('FORBIDDEN');
      const consumed = await tx.webAuthnChallenge.updateMany({
        where: {
          id: challenge.id,
          userId: input.userId,
          purpose: 'ADD_KEY',
          challengeHash,
          bindingHash,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) throw new AppError('FORBIDDEN');
      await tx.passkeyCredential.create({
        data: {
          userId: input.userId,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey),
          signCount: BigInt(credential.counter),
          transports: credential.transports ?? [],
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
          aaguid,
          label: 'Резервный ключ владельца',
        },
      });
      const marked = await tx.ownerBootstrap.updateMany({
        where: { id: OWNER_BOOTSTRAP_SINGLETON_ID, userId: input.userId, completedAt: null },
        data: { completedAt: now },
      });
      if (marked.count !== 1) throw new AppError('FORBIDDEN');
      await tx.adminAuditLog.create({
        data: {
          adminId: input.userId,
          action: 'OWNER_BOOTSTRAP_COMPLETED',
          metadata: { activePasskeys: 2 },
        },
      });
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError('CONFLICT');
    }
    throw error;
  }
  return { completed: true };
}
