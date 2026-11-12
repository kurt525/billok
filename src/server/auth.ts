import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { db } from './db';
import { logger } from './lib/logger';
import { consumePasskeyLoginTicket } from './lib/passkey-login';

// A verified, short-lived WebAuthn ticket is the ONLY credential accepted.
// No additional identity provider, adapter or external account linking exists.
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: 'jwt' },
  pages: { signIn: '/login', error: '/login' },
  providers: [
    // Only a previously VERIFIED WebAuthn assertion can mint this short-lived,
    // one-time login ticket. No password, email link or OAuth identity accepted.
    Credentials({
      id: 'passkey',
      name: 'BillOK Passkey',
      credentials: { ticket: { label: 'Passkey proof', type: 'text' } },
      authorize: (credentials) => consumePasskeyLoginTicket({ db, token: credentials?.ticket }),
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user?.id) {
        // The passkey login ticket is already verified and single-use.
        token.id = user.id;
        token.sessionSecurityVersion = undefined; // assign from DB, never from a browser claim
      }
      if (typeof token.id !== 'string') return token;
      try {
        const fresh = await db.user.findUnique({
          where: { id: token.id },
          select: {
            name: true,
            locale: true,
            emailVerified: true,
            suspendedAt: true,
            sessionSecurityVersion: true,
          },
        });
        if (!fresh?.emailVerified || fresh.suspendedAt) {
          token.sessionSecurityValid = false;
          return token;
        }
        if (user?.id) {
          token.sessionSecurityVersion = fresh.sessionSecurityVersion;
        }
        // Fail closed for a legacy JWT, a revoked JWT, or a malformed version.
        token.sessionSecurityValid =
          typeof token.sessionSecurityVersion === 'number' &&
          token.sessionSecurityVersion === fresh.sessionSecurityVersion;
        if (token.sessionSecurityValid) {
          token.name = fresh.name;
          token.locale = fresh.locale;
        }
      } catch (error) {
        token.sessionSecurityValid = false;
        logger.warn('auth.session_refresh_failed', {
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
      return token;
    },
    session({ session, token }) {
      if (
        token.sessionSecurityValid !== true ||
        typeof token.id !== 'string' ||
        !Number.isSafeInteger(token.sessionSecurityVersion)
      ) {
        // Security-version rotation can terminate old JWTs even before their
        // cookie expires; middleware and protected endpoints see no user.
        const { user: _ignored, ...withoutUser } = session;
        void _ignored;
        return withoutUser;
      }
      if (session.user) {
        session.user.id = token.id;
        session.user.name = (token.name as string | null | undefined) ?? session.user.name ?? null;
        if (typeof token.locale === 'string') session.user.locale = token.locale;
      }
      return session;
    },
  },
});
