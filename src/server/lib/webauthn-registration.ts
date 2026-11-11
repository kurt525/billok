import { createHash, randomBytes } from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import { AppError } from './app-error';
import { OWNER_BOOTSTRAP_SINGLETON_ID } from './owner-bootstrap';
import {
  readBillokWebAuthnRelyingParty,
  WEBAUTHN_CHALLENGE_TTL_MS,
  WEBAUTHN_PASSKEY_POLICY,
} from './webauthn-relying-party';

export const WEBAUTHN_BINDING_COOKIE = 'billok-passkey-registration';
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export function newWebAuthnBindingSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashWebAuthnBinding(secret: string): string {
  if (!SECRET.test(secret)) throw new AppError('BAD_REQUEST');
  return hash(secret);
}

function clientChallenge(response: RegistrationResponseJSON): string {
  try {
    const json = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')) as {
      challenge?: unknown;
    };
    if (typeof json.challenge !== 'string' || !SECRET.test(json.challenge)) throw new Error('Invalid challenge');
    return json.challenge;
  } catch {
    throw new AppError('BAD_REQUEST');
  }
}

export async function beginFirstPasskeyRegistration(input: {
  db: PrismaClient;
  userId: string;
  bindingSecret: string;
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const user = await input.db.user.findUnique({
    where: { id: input.userId },
    select: {
      id: true,
      email: true,
      name: true,
      emailVerified: true,
      registrationEmailVerificationRequired: true,
      suspendedAt: true,
      webAuthnUserHandle: true,
      passkeyCredentials: { where: { revokedAt: null }, select: { id: true }, take: 1 },
    },
  });
  if (
    !user?.emailVerified ||
    user.suspendedAt ||
    !user.registrationEmailVerificationRequired ||
    user.passkeyCredentials.length
  ) {
    throw new AppError('FORBIDDEN');
  }
  if (!user.webAuthnUserHandle) {
    await input.db.user.updateMany({
      where: { id: user.id, webAuthnUserHandle: null },
      data: { webAuthnUserHandle: randomBytes(32).toString('base64url') },
    });
  }
  const stable = await input.db.user.findUnique({
    where: { id: user.id },
    select: { webAuthnUserHandle: true },
  });
  if (!stable?.webAuthnUserHandle) throw new AppError('CONFLICT');
  const rp = readBillokWebAuthnRelyingParty(input.env ?? process.env);
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpId,
    userID: new Uint8Array(Buffer.from(stable.webAuthnUserHandle, 'base64url')),
    userName: user.email,
    userDisplayName: user.name ?? user.email,
    attestationType: WEBAUTHN_PASSKEY_POLICY.attestationType,
    authenticatorSelection: {
      residentKey: WEBAUTHN_PASSKEY_POLICY.residentKey,
      userVerification: WEBAUTHN_PASSKEY_POLICY.userVerification,
    },
    timeout: WEBAUTHN_CHALLENGE_TTL_MS,
  });
  await input.db.webAuthnChallenge.create({
    data: {
      userId: user.id,
      purpose: 'REGISTER',
      challengeHash: hash(options.challenge),
      bindingHash: hashWebAuthnBinding(input.bindingSecret),
      expiresAt: new Date(now.getTime() + WEBAUTHN_CHALLENGE_TTL_MS),
    },
  });
  return options;
}

export async function finishFirstPasskeyRegistration(input: {
  db: PrismaClient;
  bindingSecret: string;
  response: RegistrationResponseJSON;
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
}): Promise<{ registered: true }> {
  const now = input.now ?? new Date();
  const digest = hash(clientChallenge(input.response));
  const bindingHash = hashWebAuthnBinding(input.bindingSecret);
  const request = await input.db.webAuthnChallenge.findUnique({ where: { challengeHash: digest } });
  if (
    !request ||
    request.purpose !== 'REGISTER' ||
    request.bindingHash !== bindingHash ||
    !request.userId ||
    request.usedAt ||
    request.expiresAt <= now
  ) {
    throw new AppError('FORBIDDEN');
  }
  const rp = readBillokWebAuthnRelyingParty(input.env ?? process.env);
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: (value) => hash(value) === request.challengeHash,
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
      // Serialize two concurrent first-credential completions for one user.
      await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', request.userId);
      const user = await tx.user.findUnique({
        where: { id: request.userId! },
        select: {
          emailVerified: true,
          suspendedAt: true,
          passkeyCredentials: { where: { revokedAt: null }, select: { id: true }, take: 1 },
        },
      });
      if (!user?.emailVerified || user.suspendedAt || user.passkeyCredentials.length) throw new AppError('FORBIDDEN');
      const updated = await tx.webAuthnChallenge.updateMany({
        where: {
          id: request.id,
          userId: request.userId,
          usedAt: null,
          expiresAt: { gt: now },
          challengeHash: digest,
          bindingHash,
          purpose: 'REGISTER',
        },
        data: { usedAt: now },
      });
      if (updated.count !== 1) throw new AppError('FORBIDDEN');
      await tx.passkeyCredential.create({
        data: {
          userId: request.userId!,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey),
          signCount: BigInt(credential.counter),
          transports: credential.transports ?? [],
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
          aaguid,
        },
      });
      // Initial owner setup is complete with ONE verified Passkey.
      // No second device is required; additional owner keys are optional.
      // This shares the user row lock and transaction with first-key creation.
      const owner = await tx.ownerBootstrap.findUnique({
        where: { id: OWNER_BOOTSTRAP_SINGLETON_ID },
        select: { userId: true, completedAt: true },
      });
      if (owner?.userId === request.userId) {
        if (owner.completedAt) throw new AppError('FORBIDDEN');
        const completed = await tx.ownerBootstrap.updateMany({
          where: { id: OWNER_BOOTSTRAP_SINGLETON_ID, userId: request.userId!, completedAt: null },
          data: { completedAt: now },
        });
        if (completed.count !== 1) throw new AppError('FORBIDDEN');
        await tx.adminAuditLog.create({
          data: {
            adminId: request.userId!,
            action: 'OWNER_BOOTSTRAP_COMPLETED',
            metadata: { activePasskeys: 1, optionalMaxPasskeys: 3 },
          },
        });
      }
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new AppError('CONFLICT');
    throw error;
  }
  return { registered: true };
}

/**
 * A confirmed invited user with no credential may retry a failed first-key
 * ceremony using the SAME already-consumed email token within its original
 * expiry. An existing credential or suspended account always closes this path.
 * Email proof only opens registration; it never creates an Auth.js session.
 */
export async function canRetryInvitedFirstPasskey(
  db: PrismaClient,
  userId: string,
  tokenHash: string,
  now: Date = new Date(),
): Promise<boolean> {
  const request = await db.emailVerificationRequest.findUnique({
    where: { tokenHash },
    select: { userId: true, consumedAt: true, expiresAt: true },
  });
  if (!request || request.userId !== userId || !request.consumedAt || request.expiresAt <= now) return false;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      emailVerified: true,
      registrationEmailVerificationRequired: true,
      suspendedAt: true,
      isPlaceholder: true,
      passkeyCredentials: { where: { revokedAt: null }, select: { id: true }, take: 1 },
    },
  });
  return Boolean(
    user?.emailVerified &&
    user.registrationEmailVerificationRequired &&
    !user.suspendedAt &&
    !user.isPlaceholder &&
    user.passkeyCredentials.length === 0,
  );
}
