import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import { AppError } from './app-error';
import { normalizeAllowedRegistrationEmail } from './registration-email-domain';
import { readBillokWebAuthnRelyingParty, WEBAUTHN_CHALLENGE_TTL_MS } from './webauthn-relying-party';
import { revokeAccountAuthenticationStateInTransaction } from './revoke-account-auth';
import {
  emailChangeNotificationExpiry,
  encryptEmailChangeRecipient,
  sendEmailChangeConfirmation,
} from './email-change-notification';
import { checkTokenRateLimit } from './rate-limit';

export const EMAIL_CHANGE_TTL_MS = 30 * 60_000;
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
export const emailChangeDigest = (value: string) =>
  createHash('sha256').update('billok:email-change:v1\0').update(value).digest('hex');
export type EmailChangeSession = { userId: string; version: number; binding: string };
type Store = Prisma.TransactionClient;
type Env = Record<string, string | undefined>;
type Input = { db: PrismaClient; session: EmailChangeSession; now?: Date; env?: Env };

async function account(tx: Store, session: EmailChangeSession) {
  // Same lock order as recovery, login and privileged actions.
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${session.userId} FOR UPDATE`;
  const owner = await tx.ownerBootstrap.findUnique({ where: { id: 1 }, select: { userId: true } });
  const user = await tx.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      email: true,
      emailVerified: true,
      isPlaceholder: true,
      suspendedAt: true,
      sessionSecurityVersion: true,
      passkeyCredentials: {
        where: { revokedAt: null },
        select: { id: true, credentialId: true, transports: true },
        take: 4,
      },
    },
  });
  if (
    !owner ||
    owner.userId === session.userId ||
    !user?.emailVerified ||
    user.isPlaceholder ||
    user.suspendedAt ||
    user.sessionSecurityVersion !== session.version ||
    !normalizeAllowedRegistrationEmail(user.email) ||
    !user.passkeyCredentials.length ||
    !/^[a-f0-9]{64}$/u.test(session.binding)
  )
    throw new AppError('FORBIDDEN');
  return user;
}

async function ensureAvailable(tx: Store, newEmail: string) {
  // Exact case-insensitive equality; ILIKE would interpret email underscores.
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM "User" WHERE lower(email) = lower(${newEmail}) LIMIT 1`;
  if (rows.length) throw new AppError('CONFLICT');
}

function sameRequest(
  request: { oldEmailHash: string; sessionBindingHash: string; sessionSecurityVersion: number; expiresAt: Date },
  user: { email: string },
  session: EmailChangeSession,
  now: Date,
) {
  return (
    request.oldEmailHash === emailChangeDigest(user.email) &&
    request.sessionBindingHash === session.binding &&
    request.sessionSecurityVersion === session.version &&
    request.expiresAt > now
  );
}

export async function emailChangeStatus(input: Input) {
  return input.db.$transaction(async (tx) => {
    const owner = await tx.ownerBootstrap.findUnique({ where: { id: 1 }, select: { userId: true } });
    if (!owner) throw new AppError('FORBIDDEN');
    if (owner.userId === input.session.userId) return { allowed: false, owner: true, pending: null };
    const user = await account(tx, input.session);
    const now = input.now ?? new Date();
    const request = await tx.emailChangeRequest.findUnique({ where: { userId: user.id } });
    return {
      allowed: true,
      owner: false,
      pending:
        request?.approvedAt &&
        request.signerCredentialRowId &&
        user.passkeyCredentials.some((k) => k.id === request.signerCredentialRowId) &&
        sameRequest(request, user, input.session, now)
          ? { email: request.newEmail, expiresAt: request.expiresAt.toISOString() }
          : null,
    };
  });
}

export async function beginEmailChange(input: Input & { email: string }) {
  const newEmail = normalizeAllowedRegistrationEmail(input.email);
  if (!newEmail) throw new AppError('BAD_REQUEST');
  const rp = readBillokWebAuthnRelyingParty(input.env ?? process.env);
  return input.db.$transaction(async (tx) => {
    const user = await account(tx, input.session);
    const now = input.now ?? new Date();
    if (newEmail === normalizeAllowedRegistrationEmail(user.email)) throw new AppError('BAD_REQUEST');
    await ensureAvailable(tx, newEmail);
    const options = await generateAuthenticationOptions({
      rpID: rp.rpId,
      userVerification: 'required',
      timeout: WEBAUTHN_CHALLENGE_TTL_MS,
      allowCredentials: user.passkeyCredentials.map((k) => ({
        id: k.credentialId,
        transports: k.transports as ('usb' | 'nfc' | 'ble' | 'internal' | 'hybrid')[],
      })),
    });
    const expiresAt = new Date(now.getTime() + WEBAUTHN_CHALLENGE_TTL_MS);
    const data = {
      id: randomUUID(),
      oldEmailHash: emailChangeDigest(user.email),
      newEmail,
      sessionBindingHash: input.session.binding,
      sessionSecurityVersion: input.session.version,
      challengeHash: emailChangeDigest(options.challenge),
      challengeExpiresAt: expiresAt,
      expiresAt,
      createdAt: now,
      approvedAt: null,
      tokenHash: null,
      signerCredentialRowId: null,
    };
    await tx.emailChangeRequest.upsert({
      where: { userId: user.id },
      create: { ...data, userId: user.id },
      update: data,
    });
    await tx.securityEvent.create({ data: { actorId: user.id, action: 'EMAIL_CHANGE_STARTED', outcome: 'ALLOWED' } });
    return options;
  });
}

export async function approveEmailChange(input: Input & { response: AuthenticationResponseJSON }) {
  const env = input.env ?? process.env;
  const rp = readBillokWebAuthnRelyingParty(env);
  const token = randomBytes(32).toString('base64url');
  const pending = await input.db.$transaction(async (tx) => {
    const user = await account(tx, input.session);
    const now = input.now ?? new Date();
    const request = await tx.emailChangeRequest.findUnique({ where: { userId: user.id } });
    if (
      !request ||
      request.approvedAt ||
      request.challengeExpiresAt <= now ||
      !sameRequest(request, user, input.session, now)
    )
      throw new AppError('FORBIDDEN');
    if (typeof input.response?.id !== 'string' || input.response.id.length > 512) throw new AppError('FORBIDDEN');
    const signer = await tx.passkeyCredential.findUnique({ where: { credentialId: input.response.id } });
    if (
      !signer ||
      signer.userId !== user.id ||
      signer.revokedAt ||
      signer.signCount < BigInt(0) ||
      signer.signCount > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new AppError('FORBIDDEN');
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: (challenge) => emailChangeDigest(challenge) === request.challengeHash,
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
      !result.verified ||
      !result.authenticationInfo.userVerified ||
      result.authenticationInfo.credentialID !== signer.credentialId
    )
      throw new AppError('FORBIDDEN');
    const counter = result.authenticationInfo.newCounter;
    if (
      !Number.isSafeInteger(counter) ||
      counter < 0 ||
      ((counter !== 0 || signer.signCount !== BigInt(0)) && BigInt(counter) <= signer.signCount)
    )
      throw new AppError('FORBIDDEN');
    await ensureAvailable(tx, request.newEmail);
    if (!checkTokenRateLimit('email-change-delivery:' + emailChangeDigest(request.newEmail), 3, 60 * 60_000).allowed)
      throw new AppError('TOO_MANY_REQUESTS');
    const changed = await tx.passkeyCredential.updateMany({
      where: { id: signer.id, revokedAt: null, signCount: signer.signCount },
      data: {
        signCount: BigInt(counter),
        lastUsedAt: now,
        deviceType: result.authenticationInfo.credentialDeviceType,
        backedUp: result.authenticationInfo.credentialBackedUp,
      },
    });
    if (changed.count !== 1) throw new AppError('FORBIDDEN');
    const expiresAt = new Date(now.getTime() + EMAIL_CHANGE_TTL_MS);
    await tx.emailChangeRequest.update({
      where: { id: request.id },
      data: { approvedAt: now, signerCredentialRowId: signer.id, tokenHash: emailChangeDigest(token), expiresAt },
    });
    await tx.securityEvent.create({ data: { actorId: user.id, action: 'EMAIL_CHANGE_REQUESTED', outcome: 'ALLOWED' } });
    return { id: request.id, email: request.newEmail, expiresAt: expiresAt.toISOString() };
  });
  // A failed SMTP delivery never changes the account. The request remains
  // pending; a deliberate fresh Passkey approval replaces it with a new token.
  try {
    await sendEmailChangeConfirmation(pending.email, token, env);
  } catch {
    return { email: pending.email, expiresAt: pending.expiresAt, delivered: false };
  }
  return { email: pending.email, expiresAt: pending.expiresAt, delivered: true };
}

export async function cancelEmailChange(input: Input) {
  return input.db.$transaction(async (tx) => {
    const user = await account(tx, input.session);
    await tx.emailChangeRequest.deleteMany({ where: { userId: user.id } });
    await tx.securityEvent.create({ data: { actorId: user.id, action: 'EMAIL_CHANGE_CANCELLED', outcome: 'ALLOWED' } });
    return { cancelled: true };
  });
}

export async function completeEmailChange(input: Input & { token: string }) {
  if (!SECRET.test(input.token)) throw new AppError('FORBIDDEN');
  try {
    await input.db.$transaction(async (tx) => {
      const user = await account(tx, input.session);
      const now = input.now ?? new Date();
      const request = await tx.emailChangeRequest.findUnique({ where: { userId: user.id } });
      if (
        !request ||
        !request.approvedAt ||
        request.tokenHash !== emailChangeDigest(input.token) ||
        !sameRequest(request, user, input.session, now) ||
        !request.signerCredentialRowId ||
        !user.passkeyCredentials.some((k) => k.id === request.signerCredentialRowId) ||
        normalizeAllowedRegistrationEmail(request.newEmail) !== request.newEmail
      )
        throw new AppError('FORBIDDEN');
      await ensureAvailable(tx, request.newEmail);
      const encryptedRecipient = encryptEmailChangeRecipient(user.email, request.id, input.env ?? process.env);
      // Recheck the sole owner record and user under the same row lock.
      const owner = await tx.ownerBootstrap.findUnique({ where: { id: 1 }, select: { userId: true } });
      if (!owner || owner.userId === user.id) throw new AppError('FORBIDDEN');
      await tx.user.update({ where: { id: user.id }, data: { email: request.newEmail, emailVerified: now } });
      await revokeAccountAuthenticationStateInTransaction(tx, user.id);
      await tx.emailVerificationRequest.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.emailChangeRequest.delete({ where: { id: request.id } });
      await tx.emailChangeNotification.create({
        data: { id: request.id, userId: user.id, encryptedRecipient, expiresAt: emailChangeNotificationExpiry(now) },
      });
      await tx.securityEvent.create({
        data: { actorId: user.id, action: 'EMAIL_CHANGE_COMPLETED', outcome: 'ALLOWED' },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new AppError('CONFLICT');
    throw error;
  }
  return { changed: true };
}
