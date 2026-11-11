import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { db } from './db';
import { logger } from './lib/logger';
import { consumePasskeyLoginTicket } from './lib/passkey-login';

// A verified, short-lived WebAuthn ticket is the ONLY credential accepted.
// Magic Link, OAuth and OIDC remain outside this password-removal stage.
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
        token.id = user.id;
        if (user.name !== undefined) token.name = user.name;
        if (user.locale !== undefined) token.locale = user.locale;
      }
      if (token.id) {
        try {
          const fresh = await db.user.findUnique({
            where: { id: token.id as string },
            select: { name: true, locale: true },
          });
          if (fresh?.name) token.name = fresh.name;
          if (fresh?.locale) token.locale = fresh.locale;
        } catch (error) {
          logger.warn('auth.session_refresh_failed', {
            error: error instanceof Error ? error.name : 'unknown',
          });
        }
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.name = (token.name as string | null | undefined) ?? session.user.name ?? null;
        if (typeof token.locale === 'string') session.user.locale = token.locale;
      }
      return session;
    },
  },
});
