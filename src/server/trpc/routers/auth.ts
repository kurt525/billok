import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AppError } from '@/server/lib/app-error';
import { createTRPCRouter, publicProcedure, protectedProcedure } from '../init';
import { checkRateLimit, parsePositiveInt } from '../../lib/rate-limit';
import { getClientIp } from '../../lib/client-ip';
import { locales } from '@/i18n/routing';
import { stripUndefined } from '../../lib/strip-undefined';
import { readRegistrationEmailConfig } from '../../lib/auth-config';
import { readRegistrationMode } from '../../lib/registration-mode';
import { runRegistrationCleanupIfDue } from '../../lib/registration-cleanup-trigger';
import { confirmRegistrationEmail } from '../../lib/registration-email-confirmation';
import { findUsersByEmail } from '../../lib/user-email';
import { activeSystemInviteWindow } from '../../lib/system-invite-lifetime';
import { EMAIL_VERIFICATION_TOKEN_TTL_MS } from '../../lib/email-verification-token';
import { recordOwnerSecurityEvent } from '../../lib/security-event-audit';
import {
  isAllowedRegistrationEmailDomain,
  normalizeAllowedRegistrationEmail,
} from '../../lib/registration-email-domain';
import { createAndDeliverPendingInviteRegistration } from '../../lib/registration-invite-delivery';
import {
  allowRegistrationVerificationResend,
  runExclusiveRegistrationVerificationResend,
} from '../../lib/registration-resend-rate-limit';
import { findPendingRegistrationForResend } from '../../lib/registration-resend-eligibility';
import { deliverPendingVerificationResend } from '../../lib/registration-resend-delivery';
import { isSupportedSbpBankId, normalizeSbpPhone, SBP_BANKS } from '@/lib/sbp-banks';

export const authRouter = createTRPCRouter({
  getSession: publicProcedure.query(({ ctx }) => {
    return ctx.session;
  }),

  // Which sign-in methods the login page should offer. Never includes the
  // OIDC issuer, client ids or secrets — only what the UI renders.
  getLoginOptions: publicProcedure.query(() => {
    // Only an assertion-backed Passkey ticket can authenticate.
    return { passkeyLogin: true };
  }),

  getRegistrationMode: publicProcedure.query(async ({ ctx }) => {
    const mode = await readRegistrationMode(ctx.db);
    // BillOK accepts new registrations by invitation only. A legacy "open"
    // setting is not permission to bypass the code; show the code field.
    return { mode: mode === 'closed' ? ('closed' as const) : ('invite-only' as const) };
  }),

  register: publicProcedure
    .input(
      z.strictObject({
        name: z.string().trim().min(1).max(100),
        email: z
          .string()
          .email()
          .transform((value) => normalizeAllowedRegistrationEmail(value) ?? value),
        inviteCode: z.string().trim().max(128).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // IP, global and hashed-email limits apply BEFORE any account lookup.
      // Never store raw email in the limiter or security journal.
      const ip = getClientIp(ctx.headers);
      const emailHash = createHash('sha256')
        .update('billok-registration-probe:' + input.email.trim().toLowerCase())
        .digest('hex');
      const auditProbe = async () =>
        recordOwnerSecurityEvent({
          db: ctx.db,
          action: 'AUTH_REGISTRATION_PROBE',
          outcome: 'DENIED',
          targetFingerprint: emailHash,
        });
      const auditAccepted = async () =>
        recordOwnerSecurityEvent({
          db: ctx.db,
          action: 'AUTH_REGISTRATION_SUBMITTED',
          outcome: 'ALLOWED',
          targetFingerprint: emailHash,
        });
      const maxRegAttempts = parsePositiveInt(process.env.REGISTER_RATE_LIMIT_MAX, 10);
      if (
        !checkRateLimit('register:global', 600, 60 * 60 * 1000).allowed ||
        !checkRateLimit('register:' + ip, maxRegAttempts, 60 * 60 * 1000).allowed ||
        !checkRateLimit('register:email:' + emailHash, 20, 60 * 60 * 1000).allowed
      ) {
        await auditProbe();
        throw new AppError('TOO_MANY_REQUESTS', 'registerRateLimited');
      }

      const mode = await readRegistrationMode(ctx.db);
      if (mode === 'closed') {
        await auditProbe();
        throw new AppError('FORBIDDEN', 'registrationClosed');
      }

      // Enforce the single supported registration path irrespective of the
      // legacy "open" registration setting. Providers cannot register users.
      if (!input.inviteCode) {
        await auditProbe();
        throw new AppError('FORBIDDEN', 'inviteCodeRequired');
      }
      if (!isAllowedRegistrationEmailDomain(input.email)) {
        await auditProbe();
        throw new AppError('BAD_REQUEST', 'registrationEmailDomainInvalid');
      }

      // Check the mail configuration BEFORE reserving an invite or creating
      // an account; never return a fake pending signup when SMTP is missing.
      let emailConfig: ReturnType<typeof readRegistrationEmailConfig>;
      try {
        emailConfig = readRegistrationEmailConfig(process.env);
      } catch {
        throw new AppError('SERVICE_UNAVAILABLE', 'registrationEmailUnavailable');
      }

      // Validate the invitation BEFORE looking up the email, so invalid code
      // + known email and invalid code + unknown email respond identically.
      const now = new Date();
      const eligible = await ctx.db.systemInvite.findFirst({
        where: {
          code: input.inviteCode,
          usedAt: null,
          usedById: null,
          revokedAt: null,
          ...activeSystemInviteWindow(now),
          OR: [{ reservedUntil: null }, { reservedUntil: { lte: now } }],
        },
        select: { id: true },
      });
      if (!eligible) {
        await auditProbe();
        throw new AppError('FORBIDDEN', 'inviteCodeInvalid');
      }

      // Reserve the same single-use code for a known email as for a new
      // pending signup, without creating a second account, sending a new
      // confirmation or changing the existing user's status. Otherwise a
      // caller with an invite could probe again with their own email and
      // infer account existence from the code remaining available.
      const reserveWithoutSignup = async (existingUserId: string) => {
        await ctx.db.systemInvite.updateMany({
          where: {
            id: eligible.id,
            code: input.inviteCode!,
            usedAt: null,
            usedById: null,
            revokedAt: null,
            ...activeSystemInviteWindow(new Date()),
            OR: [{ reservedUntil: null }, { reservedUntil: { lte: new Date() } }],
          },
          data: {
            reservedById: existingUserId,
            reservedUntil: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
          },
        });
      };
      const acknowledgement = { email: input.email, verificationRequired: true as const };
      await runRegistrationCleanupIfDue(ctx.db);
      const existing = await findUsersByEmail(ctx.db, input.email);
      if (existing.length) {
        await reserveWithoutSignup(existing[0]!.id);
        await auditAccepted();
        return acknowledgement;
      }

      let pending: Awaited<ReturnType<typeof createAndDeliverPendingInviteRegistration>>;
      try {
        pending = await createAndDeliverPendingInviteRegistration({
          db: ctx.db,
          name: input.name,
          email: input.email,
          inviteCode: input.inviteCode,
          ...emailConfig,
        });
      } catch (error) {
        if (error instanceof AppError && error.code === 'CONFLICT') {
          // A concurrent account creation won a different invite; make this
          // invite no more revealing than the primary existing-email path.
          const winner = await findUsersByEmail(ctx.db, input.email);
          if (winner.length) await reserveWithoutSignup(winner[0]!.id);
          await auditAccepted();
          return acknowledgement;
        }
        if (error instanceof AppError) throw error;
        throw new AppError('SERVICE_UNAVAILABLE', 'registrationEmailUnavailable');
      }
      // Do not reveal whether email was delivered or the account was reused.
      void pending;
      await auditAccepted();
      return acknowledgement;
    }),

  // A POST mutation prevents mail scanners from consuming links on GET.
  confirmEmail: publicProcedure
    .input(z.strictObject({ token: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const ip = getClientIp(ctx.headers);
      // Never persist raw email links or token contents, even for failed probes.
      const fingerprint = createHash('sha256')
        .update('billok-confirm-email-attempt:' + input.token)
        .digest('hex');
      const auditAttempt = async (outcome: 'ALLOWED' | 'DENIED') =>
        recordOwnerSecurityEvent({
          db: ctx.db,
          action: 'AUTH_EMAIL_CONFIRM_ATTEMPT',
          outcome,
          targetFingerprint: fingerprint,
        });
      const maxAttempts = parsePositiveInt(process.env.EMAIL_CONFIRM_RATE_LIMIT_MAX, 10);
      const hour = 60 * 60 * 1000;
      if (
        !checkRateLimit('confirm-registration-email:global', 600, hour).allowed ||
        !checkRateLimit('confirm-registration-email:' + ip, maxAttempts, hour).allowed ||
        !checkRateLimit('confirm-registration-email:token:' + fingerprint, 5, hour).allowed
      ) {
        await auditAttempt('DENIED');
        throw new AppError('TOO_MANY_REQUESTS', 'emailVerificationRateLimited');
      }

      // One-time verification never creates a session. No account lookup
      // outcome is disclosed except to the holder of a valid email token.
      const verified = await confirmRegistrationEmail(ctx.db, input.token);
      await auditAttempt(verified ? 'ALLOWED' : 'DENIED');
      if (!verified) throw new AppError('BAD_REQUEST', 'emailVerificationLinkInvalid');
      return { verified: true };
    }),

  // Return the same acknowledgement for unknown, verified and rate-limited
  // addresses; never reveal user, invitation or token information.
  resendRegistrationVerification: publicProcedure
    .input(z.object({ email: z.string().email().max(254) }))
    .mutation(async ({ ctx, input }) => {
      const acknowledgement = { accepted: true as const };
      const fingerprint = createHash('sha256')
        .update('billok-registration-resend:' + input.email.trim().toLowerCase())
        .digest('hex');
      const auditAttempt = async (outcome: 'ALLOWED' | 'DENIED') =>
        recordOwnerSecurityEvent({
          db: ctx.db,
          action: 'AUTH_REGISTRATION_RESEND_ATTEMPT',
          outcome,
          targetFingerprint: fingerprint,
        });
      if (!allowRegistrationVerificationResend(ctx.headers, input.email)) {
        await auditAttempt('DENIED');
        return acknowledgement;
      }
      // Audit permitted requests identically for missing, pending and
      // already verified accounts. Never disclose their existence.
      await auditAttempt('ALLOWED');
      if (!isAllowedRegistrationEmailDomain(input.email)) {
        return acknowledgement;
      }

      let emailConfig: ReturnType<typeof readRegistrationEmailConfig>;
      try {
        emailConfig = readRegistrationEmailConfig(process.env);
      } catch {
        return acknowledgement;
      }

      try {
        // The limiter is checked first. Overlapping requests for the same
        // normalized address share one in-process SMTP operation.
        await runExclusiveRegistrationVerificationResend(input.email, async () => {
          const pending = await findPendingRegistrationForResend(ctx.db, input.email);
          if (pending) {
            await deliverPendingVerificationResend({
              db: ctx.db,
              userId: pending.userId,
              inviteCode: pending.inviteCode,
              email: pending.email,
              ...emailConfig,
            });
          }
        });
      } catch {
        // Never expose SMTP, account or invitation errors to the caller.
      }
      return acknowledgement;
    }),

  // Issue #1 6.10.2.1: read-only inventory. Never return credential IDs,
  // public keys, counters or any other authentication material to a client.
  listPasskeys: protectedProcedure.query(async ({ ctx }) => {
    // The impersonation feature is never permission to inspect another
    // account's authentication keys, even if a profile is visible.
    if (ctx.impersonating) throw new AppError('FORBIDDEN');
    const owner = await ctx.db.ownerBootstrap.findUnique({
      where: { id: 1 },
      select: { userId: true, completedAt: true },
    });
    const isOwner = owner?.userId === ctx.user.id && Boolean(owner.completedAt);
    const credentials = await ctx.db.passkeyCredential.findMany({
      where: { userId: ctx.user.id },
      select: {
        id: true,
        label: true,
        deviceType: true,
        backedUp: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    return {
      isOwner,
      maxActivePasskeys: isOwner ? 3 : 1,
      activeCount: credentials.filter((credential) => !credential.revokedAt).length,
      credentials,
    };
  }),

  getProfile: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        venmoUsername: true,
        sbpPhone: true,
        sbpBankId: true,
        locale: true,
        defaultCurrency: true,
      },
    });
    if (!user) {
      throw new AppError('NOT_FOUND', 'userNotFound');
    }
    return user;
  }),

  updateProfile: protectedProcedure
    .input(
      z.strictObject({
        name: z.string().trim().min(1).max(100).optional(),
        defaultCurrency: z.string().length(3).optional(),
        locale: z.enum(locales).optional(),
        venmoUsername: z.string().max(50).nullable().optional(),
        sbpPhone: z.string().max(24).nullable().optional(),
        sbpBankId: z.string().max(40).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const phone =
        input.sbpPhone === undefined || input.sbpPhone === null || input.sbpPhone.trim() === ''
          ? null
          : normalizeSbpPhone(input.sbpPhone);
      if (input.sbpPhone && input.sbpPhone.trim() && !phone) {
        throw new AppError('BAD_REQUEST', 'sbpPhoneInvalid');
      }
      if (input.sbpBankId && !isSupportedSbpBankId(input.sbpBankId)) {
        // An old profile can retain an existing bank that disappeared from the
        // registry, but cannot newly select it (or an unknown bank ID).
        const retired = SBP_BANKS.some((bank) => bank.id === input.sbpBankId && bank.active === false);
        if (!retired) throw new AppError('BAD_REQUEST', 'sbpBankInvalid');
        const previous = await ctx.db.user.findUnique({
          where: { id: ctx.user.id },
          select: { sbpBankId: true },
        });
        if (previous?.sbpBankId !== input.sbpBankId) {
          throw new AppError('BAD_REQUEST', 'sbpBankInvalid');
        }
      }
      const data = {
        ...stripUndefined(input),
        ...(input.sbpPhone !== undefined ? { sbpPhone: phone } : {}),
        ...(input.sbpBankId !== undefined ? { sbpBankId: input.sbpBankId || null } : {}),
        ...(input.venmoUsername !== undefined ? { venmoUsername: input.venmoUsername?.trim() || null } : {}),
      };
      const user = await ctx.db.user.update({
        where: { id: ctx.user.id },
        data,
      });
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        locale: user.locale,
        venmoUsername: user.venmoUsername,
        sbpPhone: user.sbpPhone,
        sbpBankId: user.sbpBankId,
      };
    }),
});
