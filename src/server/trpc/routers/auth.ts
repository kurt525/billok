import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { AppError } from '@/server/lib/app-error';
import { createTRPCRouter, publicProcedure, protectedProcedure } from '../init';
import { checkRateLimit, parsePositiveInt } from '../../lib/rate-limit';
import { getClientIp } from '../../lib/client-ip';
import { locales } from '@/i18n/routing';
import { stripUndefined } from '../../lib/strip-undefined';
import { parseAuthConfig, readRegistrationEmailConfig } from '../../lib/auth-config';
import { readRegistrationMode } from '../../lib/registration-mode';
import { runRegistrationCleanupIfDue } from '../../lib/registration-cleanup-trigger';
import { confirmRegistrationEmail } from '../../lib/registration-email-confirmation';
import { findUsersByEmail } from '../../lib/user-email';
import { isAllowedRegistrationEmailDomain } from '../../lib/registration-email-domain';
import { createAndDeliverPendingInviteRegistration } from '../../lib/registration-invite-delivery';
import { isSupportedSbpBankId, normalizeSbpPhone, SBP_BANKS } from '@/lib/sbp-banks';

export const authRouter = createTRPCRouter({
  getSession: publicProcedure.query(({ ctx }) => {
    return ctx.session;
  }),

  // Which sign-in methods the login page should offer. Never includes the
  // OIDC issuer, client ids or secrets — only what the UI renders.
  getLoginOptions: publicProcedure.query(() => {
    const config = parseAuthConfig(process.env);
    return {
      passwordLogin: config.passwordLogin,
      magicLink: config.magicLink,
      oidc: config.oidc ? { name: config.oidc.displayName } : null,
      google: config.google !== null,
    };
  }),

  getRegistrationMode: publicProcedure.query(async ({ ctx }) => {
    // The register form creates password accounts; with password login
    // disabled it is closed whatever the admin setting says.
    if (!parseAuthConfig(process.env).passwordLogin) {
      return { mode: 'closed' as const };
    }
    const mode = await readRegistrationMode(ctx.db);
    // BillOK accepts new registrations by invitation only. A legacy "open"
    // setting is not permission to bypass the code; show the code field.
    return { mode: mode === 'closed' ? ('closed' as const) : ('invite-only' as const) };
  }),

  register: publicProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(100),
        email: z.string().email(),
        password: z.string().min(8).max(100),
        inviteCode: z.string().trim().max(128).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!parseAuthConfig(process.env).passwordLogin) {
        throw new AppError('FORBIDDEN', 'registrationClosed');
      }

      // Rate limit: 10 registrations per hour per IP (fall back to global key)
      const ip = getClientIp(ctx.headers);
      const maxRegAttempts = parsePositiveInt(process.env.REGISTER_RATE_LIMIT_MAX, 10);
      const { allowed } = checkRateLimit(`register:${ip}`, maxRegAttempts, 60 * 60 * 1000);
      if (!allowed) {
        throw new AppError('TOO_MANY_REQUESTS', 'registerRateLimited');
      }

      const mode = await readRegistrationMode(ctx.db);
      if (mode === 'closed') {
        throw new AppError('FORBIDDEN', 'registrationClosed');
      }

      // Enforce the single supported registration path irrespective of the
      // legacy "open" registration setting. Providers cannot register users.
      if (!input.inviteCode) {
        throw new AppError('FORBIDDEN', 'inviteCodeRequired');
      }
      if (!isAllowedRegistrationEmailDomain(input.email)) {
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

      // Cleanup and user lookup are reused; both precede the transactional
      // reservation, which is the authoritative concurrent invite check.
      await runRegistrationCleanupIfDue(ctx.db);
      if ((await findUsersByEmail(ctx.db, input.email)).length > 0) {
        throw new AppError('CONFLICT', 'emailTaken');
      }

      const passwordHash = await bcrypt.hash(input.password, 12);
      let pending: Awaited<ReturnType<typeof createAndDeliverPendingInviteRegistration>>;
      try {
        pending = await createAndDeliverPendingInviteRegistration({
          db: ctx.db,
          name: input.name,
          email: input.email,
          passwordHash,
          inviteCode: input.inviteCode,
          ...emailConfig,
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        // Do not expose SMTP details or passwords in API errors.
        throw new AppError('SERVICE_UNAVAILABLE', 'registrationEmailUnavailable');
      }

      // The user has no active session: the invite is redeemed only after the
      // link is confirmed through auth.confirmEmail.
      return { email: pending.email, verificationRequired: true as const };
    }),

  // A POST mutation prevents mail scanners from consuming links on GET.
  confirmEmail: publicProcedure
    .input(z.object({ token: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const ip = getClientIp(ctx.headers);
      const maxAttempts = parsePositiveInt(process.env.EMAIL_CONFIRM_RATE_LIMIT_MAX, 10);
      if (!checkRateLimit(`confirm-registration-email:${ip}`, maxAttempts, 60 * 60 * 1000).allowed) {
        throw new AppError('TOO_MANY_REQUESTS', 'emailVerificationRateLimited');
      }

      // Atomic, single-use verification and reservation redemption.
      // No automatic sign-in, new registration policy or deploy.
      const verified = await confirmRegistrationEmail(ctx.db, input.token);
      if (!verified) {
        throw new AppError('BAD_REQUEST', 'emailVerificationLinkInvalid');
      }
      return { verified: true };
    }),

  changePassword: protectedProcedure
    .input(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(8).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.db.user.findUnique({
        where: { id: ctx.user.id },
      });
      if (!user?.passwordHash) {
        throw new AppError('BAD_REQUEST', 'noPasswordToChange');
      }

      const valid = await bcrypt.compare(input.currentPassword, user.passwordHash);
      if (!valid) {
        throw new AppError('UNAUTHORIZED', 'wrongPassword');
      }

      const passwordHash = await bcrypt.hash(input.newPassword, 12);
      await ctx.db.user.update({
        where: { id: ctx.user.id },
        data: { passwordHash },
      });

      return { success: true };
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
        passwordHash: true,
      },
    });
    if (!user) {
      throw new AppError('NOT_FOUND', 'userNotFound');
    }
    const { passwordHash, ...profile } = user;
    return { ...profile, hasPassword: passwordHash !== null };
  }),

  updateProfile: protectedProcedure
    .input(
      z.object({
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
