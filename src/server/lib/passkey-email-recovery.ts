import { createHash } from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import { AppError } from './app-error';
import { readRegistrationEmailConfig } from './auth-config';
import {
  createEmailVerificationToken,
  hashEmailVerificationToken,
  EMAIL_VERIFICATION_TOKEN_TTL_MS,
} from './email-verification-token';
import { isAllowedRegistrationEmailDomain } from './registration-email-domain';
import { sendRussianPasskeyRecoveryEmail } from './passkey-recovery-email';
import { hashWebAuthnBinding } from './webauthn-registration';
import { revokeAccountAuthenticationStateInTransaction } from './revoke-account-auth';
import {
  readBillokWebAuthnRelyingParty,
  WEBAUTHN_CHALLENGE_TTL_MS,
  WEBAUTHN_PASSKEY_POLICY,
} from './webauthn-relying-party';
import { logger } from './logger';

export const RECOVERY_TOKEN_TTL_MS = EMAIL_VERIFICATION_TOKEN_TTL_MS;
export const PASSKEY_RECOVERY_BINDING_COOKIE = 'billok-passkey-recover';
export const RECOVERY_EMAIL_LIMIT_PER_HOUR = 3;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
type Env = Readonly<Record<string, string | undefined>>;
const isValidToken = (token: string) => TOKEN_PATTERN.test(token);

function attestationChallenge(response: RegistrationResponseJSON): string {
  try {
    const payload = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')) as {
      challenge?: unknown;
    };
    if (typeof payload.challenge !== 'string' || !TOKEN_PATTERN.test(payload.challenge)) throw new Error('Invalid');
    return payload.challenge;
  } catch {
    throw new AppError('FORBIDDEN');
  }
}

/**
 * Requesting email never starts a session and never reveals account existence.
 * DB throttling is per-account (survives process restarts), while the public
 * route also limits bursts per IP/email before this function is called.
 * Only ordinary accounts in Issue 6.8.1.3; owner rules are Issue 6.8.2.
 */
export async function requestRegularPasskeyRecovery(input: {
  db: PrismaClient;
  email: string;
  env: Env;
  now?: Date;
}): Promise<{ requested: true }> {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();
  if (!isAllowedRegistrationEmailDomain(email) || email.length > 254) return { requested: true };
  const user = await input.db.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      emailVerified: true,
      suspendedAt: true,
      isPlaceholder: true,
      passkeyCredentials: { where: { revokedAt: null }, select: { id: true }, take: 2 },
    },
  });
  // Recovery is not an alternate way to complete initial invited registration.
  if (!user?.emailVerified || user.suspendedAt || user.isPlaceholder || user.passkeyCredentials.length !== 1)
    return { requested: true };
  const owner = await input.db.ownerBootstrap.findUnique({
    where: { id: 1 },
    select: { userId: true },
  });
  if (owner?.userId === user.id) return { requested: true };

  const windowStart = new Date(now.getTime() - 60 * 60 * 1000);
  // Don't generate an unlimited number of valid recovery links from retries.
  const recent = await input.db.passkeyRecoveryRequest.count({
    where: { userId: user.id, createdAt: { gt: windowStart } },
  });
  if (recent >= RECOVERY_EMAIL_LIMIT_PER_HOUR) return { requested: true };

  const mail = readRegistrationEmailConfig(input.env as Record<string, string | undefined>);
  const rp = readBillokWebAuthnRelyingParty(input.env);
  if (mail.siteOrigin !== rp.origin) throw new AppError('FORBIDDEN');
  const { token, tokenHash, expiresAt } = createEmailVerificationToken(now);
  const url = new URL('/recover-passkey', mail.siteOrigin);
  url.searchParams.set('token', token);
  // A new request invalidates older outstanding recovery links for this user.
  const created = await input.db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', user.id);
    const count = await tx.passkeyRecoveryRequest.count({
      where: { userId: user.id, createdAt: { gt: windowStart } },
    });
    if (count >= RECOVERY_EMAIL_LIMIT_PER_HOUR) return null;
    await tx.passkeyRecoveryRequest.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { consumedAt: now },
    });
    return tx.passkeyRecoveryRequest.create({
      data: { userId: user.id, tokenHash, emailHash: digest(user.email), expiresAt },
      select: { id: true },
    });
  });
  if (!created) return { requested: true };
  try {
    await sendRussianPasskeyRecoveryEmail({ to: user.email, url: url.toString(), ...mail });
  } catch (error) {
    // A failure to send must make this recovery link invalid. Do not leak
    // SMTP errors, token or user identity to public callers.
    await input.db.passkeyRecoveryRequest.updateMany({
      where: { id: created.id, userId: user.id, consumedAt: null },
      data: { consumedAt: now },
    });
    logger.warn('auth.passkey_recovery_mail_failed', { error: error instanceof Error ? error.name : 'unknown' });
  }
  return { requested: true };
}

async function loadRegularRecovery(db: PrismaClient, token: string, now: Date) {
  if (!isValidToken(token)) throw new AppError('FORBIDDEN');
  const request = await db.passkeyRecoveryRequest.findUnique({
    where: { tokenHash: hashEmailVerificationToken(token) },
    include: {
      user: {
        select: {
          email: true,
          name: true,
          emailVerified: true,
          suspendedAt: true,
          isPlaceholder: true,
          webAuthnUserHandle: true,
          passkeyCredentials: { where: { revokedAt: null }, select: { id: true }, take: 2 },
        },
      },
    },
  });
  if (
    !request ||
    request.consumedAt ||
    request.expiresAt <= now ||
    request.emailHash !== digest(request.user.email) ||
    !request.user.emailVerified ||
    request.user.suspendedAt ||
    request.user.isPlaceholder ||
    !request.user.webAuthnUserHandle ||
    request.user.passkeyCredentials.length !== 1
  ) {
    throw new AppError('FORBIDDEN');
  }
  const owner = await db.ownerBootstrap.findUnique({ where: { id: 1 }, select: { userId: true } });
  if (owner?.userId === request.userId) throw new AppError('FORBIDDEN');
  return request;
}

/** Email token authorizes ONLY a browser-bound registration challenge. */
export async function beginRegularPasskeyRecovery(input: {
  db: PrismaClient;
  token: string;
  bindingSecret: string;
  env: Env;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const request = await loadRegularRecovery(input.db, input.token, now);
  const rp = readBillokWebAuthnRelyingParty(input.env);
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpId,
    userID: new Uint8Array(Buffer.from(request.user.webAuthnUserHandle!, 'base64url')),
    userName: request.user.email,
    userDisplayName: request.user.name ?? request.user.email,
    attestationType: WEBAUTHN_PASSKEY_POLICY.attestationType,
    authenticatorSelection: {
      residentKey: WEBAUTHN_PASSKEY_POLICY.residentKey,
      userVerification: WEBAUTHN_PASSKEY_POLICY.userVerification,
    },
    timeout: WEBAUTHN_CHALLENGE_TTL_MS,
  });
  const bindingHash = hashWebAuthnBinding(input.bindingSecret);
  await input.db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', request.userId);
    const current = await tx.passkeyRecoveryRequest.findUnique({ where: { id: request.id } });
    if (
      !current ||
      current.consumedAt ||
      current.expiresAt <= now ||
      current.tokenHash !== hashEmailVerificationToken(input.token)
    )
      throw new AppError('FORBIDDEN');
    await tx.webAuthnChallenge.deleteMany({ where: { userId: request.userId, purpose: 'RECOVER' } });
    const challengeHash = digest(options.challenge);
    await tx.passkeyRecoveryRequest.update({
      where: { id: request.id },
      data: { challengeHash },
    });
    await tx.webAuthnChallenge.create({
      data: {
        purpose: 'RECOVER',
        userId: request.userId,
        challengeHash,
        bindingHash,
        expiresAt: new Date(now.getTime() + WEBAUTHN_CHALLENGE_TTL_MS),
      },
    });
  });
  return options;
}

/** Every mutation (including token consumption and session revocation) commits
 * atomically AFTER real attestation verification. Never mint a login ticket. */
export async function finishRegularPasskeyRecovery(input: {
  db: PrismaClient;
  token: string;
  bindingSecret: string;
  response: RegistrationResponseJSON;
  env: Env;
  now?: Date;
}): Promise<{ recovered: true }> {
  const now = input.now ?? new Date();
  const request = await loadRegularRecovery(input.db, input.token, now);
  const challengeHash = digest(attestationChallenge(input.response));
  const bindingHash = hashWebAuthnBinding(input.bindingSecret);
  if (!request.challengeHash || request.challengeHash !== challengeHash) throw new AppError('FORBIDDEN');
  const challenge = await input.db.webAuthnChallenge.findUnique({
    where: { challengeHash },
  });
  if (
    !challenge ||
    challenge.purpose !== 'RECOVER' ||
    challenge.userId !== request.userId ||
    challenge.bindingHash !== bindingHash ||
    challenge.usedAt ||
    challenge.expiresAt <= now
  ) {
    throw new AppError('FORBIDDEN');
  }
  const rp = readBillokWebAuthnRelyingParty(input.env);
  let checked: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    checked = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: (value) => digest(value) === challengeHash,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserPresence: true,
      requireUserVerification: true,
    });
  } catch {
    throw new AppError('FORBIDDEN');
  }
  if (!checked.verified || !checked.registrationInfo.userVerified) throw new AppError('FORBIDDEN');
  const { credential, credentialDeviceType, credentialBackedUp, aaguid } = checked.registrationInfo;
  try {
    await input.db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', request.userId);
      const current = await tx.passkeyRecoveryRequest.findUnique({
        where: { id: request.id },
        include: { user: { select: { email: true, emailVerified: true, suspendedAt: true, isPlaceholder: true } } },
      });
      if (
        !current ||
        current.tokenHash !== hashEmailVerificationToken(input.token) ||
        current.consumedAt ||
        current.expiresAt <= now ||
        current.challengeHash !== challengeHash ||
        current.emailHash !== digest(current.user.email) ||
        !current.user.emailVerified ||
        current.user.suspendedAt ||
        current.user.isPlaceholder
      )
        throw new AppError('FORBIDDEN');
      const owner = await tx.ownerBootstrap.findUnique({
        where: { id: 1 },
        select: { userId: true },
      });
      if (owner?.userId === request.userId) throw new AppError('FORBIDDEN');
      const active = await tx.passkeyCredential.count({
        where: { userId: request.userId, revokedAt: null },
      });
      if (active !== 1) throw new AppError('FORBIDDEN');
      const consumed = await tx.passkeyRecoveryRequest.updateMany({
        where: {
          id: request.id,
          userId: request.userId,
          tokenHash: current.tokenHash,
          consumedAt: null,
          expiresAt: { gt: now },
          challengeHash,
        },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) throw new AppError('FORBIDDEN');
      const used = await tx.webAuthnChallenge.updateMany({
        where: {
          id: challenge.id,
          userId: request.userId,
          usedAt: null,
          challengeHash,
          bindingHash,
          purpose: 'RECOVER',
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });
      if (used.count !== 1) throw new AppError('FORBIDDEN');
      const previous = await tx.passkeyCredential.updateMany({
        where: { userId: request.userId, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.passkeyCredential.create({
        data: {
          userId: request.userId,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey),
          signCount: BigInt(credential.counter),
          transports: credential.transports ?? [],
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
          aaguid,
        },
      });
      await revokeAccountAuthenticationStateInTransaction(tx, request.userId);
      await tx.passkeyRecoveryRequest.updateMany({
        where: { userId: request.userId, consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.adminAuditLog.create({
        data: {
          adminId: request.userId,
          action: 'PASSKEY_RECOVERY_COMPLETED',
          metadata: { revokedPasskeys: previous.count, method: 'verified-email-plus-webauthn' },
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
  return { recovered: true };
}
