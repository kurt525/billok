import { randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import { AppError } from './app-error';
import { readRegistrationEmailConfig } from './auth-config';
import { isAllowedRegistrationEmailDomain } from './registration-email-domain';
import { issueRegistrationVerification } from './registration-verification-issue';
import { SYSTEM_INVITE_TTL_MS, activeSystemInviteWindow } from './system-invite-lifetime';
import { EMAIL_VERIFICATION_TOKEN_TTL_MS } from './email-verification-token';
import { readBillokWebAuthnRelyingParty } from './webauthn-relying-party';

export const OWNER_BOOTSTRAP_SINGLETON_ID = 1;
export const OWNER_BOOTSTRAP_MAX_EMAIL_ATTEMPTS = 3;
export const OWNER_BOOTSTRAP_EMAIL_COOLDOWN_MS = 60_000;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Not a public endpoint or registration fallback. A real server operator must
 * launch scripts/bootstrap-owner.ts locally and explicitly acknowledge
 * creation. No email, token, password or administrator account comes from
 * HTTP input or a user-controlled request header.
 */
export function readOwnerBootstrapConfiguration(env: Env) {
  if (env.BILLOK_OWNER_BOOTSTRAP_ACK !== 'CREATE_INITIAL_OWNER') {
    throw new AppError('FORBIDDEN');
  }
  const email = env.ADMIN_EMAIL ?? '';
  if (
    !isAllowedRegistrationEmailDomain(email) ||
    email !== email.trim().toLowerCase() ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+$/u.test(email)
  ) {
    throw new AppError('BAD_REQUEST');
  }
  const mail = readRegistrationEmailConfig(env as Record<string, string | undefined>);
  const rp = readBillokWebAuthnRelyingParty(env);
  if (mail.siteOrigin !== rp.origin) throw new AppError('BAD_REQUEST');
  return { email, mail };
}

/** Serialized by a PostgreSQL advisory transaction lock and fixed-row key. */
export async function createInitialOwner(input: {
  db: PrismaClient;
  env: Env;
  now?: Date;
}): Promise<{ userId: string; email: string }> {
  const { email } = readOwnerBootstrapConfiguration(input.env);
  const now = input.now ?? new Date();
  const code = 'owner-' + randomBytes(20).toString('hex');
  return input.db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(260110211)::text AS lock_status`);
    const [existing, users] = await Promise.all([
      tx.ownerBootstrap.findUnique({ where: { id: OWNER_BOOTSTRAP_SINGLETON_ID } }),
      tx.user.count(),
    ]);
    // A populated database cannot be bootstrapped. Never delete data here.
    if (existing || users !== 0) throw new AppError('FORBIDDEN');
    const owner = await tx.user.create({
      data: {
        email,
        name: 'Владелец',
        emailVerified: null,
        registrationEmailVerificationRequired: true,
        locale: 'ru',
      },
      select: { id: true, email: true },
    });
    await tx.ownerBootstrap.create({
      data: { id: OWNER_BOOTSTRAP_SINGLETON_ID, userId: owner.id },
    });
    // Unpublished private invitation, never displayed or reusable by public
    // registration. The same existing invite redemption validates owner email.
    await tx.systemInvite.create({
      data: {
        code,
        label: 'Первоначальная настройка владельца',
        expiresAt: new Date(now.getTime() + SYSTEM_INVITE_TTL_MS),
        reservedById: owner.id,
        reservedUntil: new Date(now.getTime() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
      },
    });
    await tx.adminAuditLog.create({
      data: { adminId: owner.id, action: 'OWNER_BOOTSTRAP_STARTED', metadata: { mode: 'local-passkey-only' } },
    });
    return { userId: owner.id, email: owner.email };
  });
}

/**
 * A local-only explicit resend is permitted for the SAME pending owner.
 * SMTP failures do not create another owner, do not reset a password, and do
 * not disclose the verification token on stdout or in audit metadata.
 */
export async function sendOwnerBootstrapConfirmation(input: {
  db: PrismaClient;
  env: Env;
  now?: Date;
}): Promise<{ sent: true }> {
  const { email, mail } = readOwnerBootstrapConfiguration(input.env);
  const now = input.now ?? new Date();
  const candidate = await input.db.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(260110211)::text AS lock_status`);
    const state = await tx.ownerBootstrap.findUnique({
      where: { id: OWNER_BOOTSTRAP_SINGLETON_ID },
      include: { user: { select: { id: true, email: true, emailVerified: true } } },
    });
    if (
      !state ||
      state.user.email !== email ||
      state.user.emailVerified ||
      state.completedAt ||
      state.emailAttempts >= OWNER_BOOTSTRAP_MAX_EMAIL_ATTEMPTS ||
      (state.lastEmailAttemptAt &&
        now.getTime() - state.lastEmailAttemptAt.getTime() < OWNER_BOOTSTRAP_EMAIL_COOLDOWN_MS)
    ) {
      throw new AppError('FORBIDDEN');
    }
    const invite = await tx.systemInvite.findFirst({
      where: {
        reservedById: state.userId,
        usedAt: null,
        usedById: null,
        revokedAt: null,
        ...activeSystemInviteWindow(now),
      },
      select: { id: true },
    });
    if (!invite) throw new AppError('FORBIDDEN');
    // Re-lease only the original owner's private, still valid invitation.
    const lease = await tx.systemInvite.updateMany({
      where: {
        id: invite.id,
        reservedById: state.userId,
        usedAt: null,
        usedById: null,
        revokedAt: null,
        ...activeSystemInviteWindow(now),
      },
      data: { reservedUntil: new Date(now.getTime() + EMAIL_VERIFICATION_TOKEN_TTL_MS) },
    });
    if (lease.count !== 1) throw new AppError('FORBIDDEN');
    await tx.emailVerificationRequest.deleteMany({
      where: { userId: state.userId, consumedAt: null },
    });
    await tx.ownerBootstrap.update({
      where: { id: OWNER_BOOTSTRAP_SINGLETON_ID },
      data: { emailAttempts: { increment: 1 }, lastEmailAttemptAt: now },
    });
    return state.user;
  });
  await issueRegistrationVerification({
    db: input.db,
    userId: candidate.id,
    email: candidate.email,
    confirmationPath: '/setup-owner',
    ...mail,
  });
  await input.db.adminAuditLog.create({
    data: {
      adminId: candidate.id,
      action: 'OWNER_BOOTSTRAP_EMAIL_SENT',
      metadata: { method: 'email-verification-no-signin' },
    },
  });
  return { sent: true };
}

/** Only for the initial owner, not ordinary invited registrants. */
export async function canRetryOwnerInitialPasskey(
  db: PrismaClient,
  userId: string,
  tokenHash: string,
  now: Date = new Date(),
) {
  const owner = await db.ownerBootstrap.findUnique({
    where: { id: OWNER_BOOTSTRAP_SINGLETON_ID },
  });
  if (!owner || owner.userId !== userId || owner.completedAt) return false;
  const [request, account] = await Promise.all([
    db.emailVerificationRequest.findUnique({ where: { tokenHash } }),
    db.user.findUnique({
      where: { id: userId },
      select: {
        emailVerified: true,
        suspendedAt: true,
        passkeyCredentials: { where: { revokedAt: null }, select: { id: true }, take: 1 },
      },
    }),
  ]);
  return Boolean(
    request &&
    request.userId === userId &&
    request.consumedAt &&
    request.expiresAt > now &&
    account?.emailVerified &&
    !account.suspendedAt &&
    account.passkeyCredentials.length === 0,
  );
}
