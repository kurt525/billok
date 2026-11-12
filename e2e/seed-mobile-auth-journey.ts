/**
 * Fixtures only for the disposable PostgreSQL created by BillOK Chromium CI.
 * No secrets or test accounts are written to the normal deployment.
 */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { hashEmailVerificationToken } from '../src/server/lib/email-verification-token';
import { SYSTEM_INVITE_TTL_MS } from '../src/server/lib/system-invite-lifetime';

async function main() {
  if (process.env.BILLOK_QA_FIXTURES !== '1') throw new Error('QA fixture opt-in is required');
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/billokqa') {
    throw new Error('Refusing to change a non-disposable database');
  }

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const unique = randomBytes(8).toString('hex');
  const ruCode = 'qa-ru-' + unique;
  const suCode = 'qa-su-' + unique;
  const expiredToken = 'E'.repeat(43);
  const passkeyFile = process.env.BILLOK_QA_PASSKEY_FILE;
  if (!passkeyFile) throw new Error('Disposable passkey fixture file is required');

  try {
    await db.systemSetting.upsert({
      where: { key: 'registrationMode' },
      update: { value: 'invite-only' },
      create: { key: 'registrationMode', value: 'invite-only' },
    });
    // Invite-only QA accounts must use the same strict seven-day expiry
    // as administrator-created invitations (Issue #1 6.2).
    const expiresAt = new Date(Date.now() + SYSTEM_INVITE_TTL_MS);
    await db.systemInvite.createMany({
      data: [
        { code: ruCode, expiresAt },
        { code: suCode, expiresAt },
      ],
    });
    const pending = await db.user.create({
      data: {
        name: 'Истёкшая регистрация QA',
        email: 'expired-' + unique + '@mail.ru',
        emailVerified: null,
        registrationEmailVerificationRequired: true,
      },
    });
    await db.emailVerificationRequest.create({
      data: {
        userId: pending.id,
        tokenHash: hashEmailVerificationToken(expiredToken),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    // Real P-256 keys: the disposable browser tests sign genuine WebAuthn assertions.
    // Private keys are written ONLY to a short-lived CI fixture file.
    const passkeys: Record<string, { userHandle: string; credentials: { id: string; privateKey: string }[] }> = {};
    for (const [alias, email, count] of [
      ['alice', 'alice@example.com', 150],
      ['bob', 'bob@example.com', 70],
      ['charlie', 'charlie@example.com', 40],
      ['recovery', 'recovery@mail.ru', 1],
    ] as const) {
      const user =
        alias === 'recovery'
          ? await db.user.create({
              data: {
                name: 'Восстановление QA',
                email,
                emailVerified: new Date(),
                registrationEmailVerificationRequired: true,
                webAuthnUserHandle: randomBytes(32).toString('base64url'),
              },
              select: { id: true, webAuthnUserHandle: true },
            })
          : await db.user.update({
              where: { email },
              data: { emailVerified: new Date(), webAuthnUserHandle: randomBytes(32).toString('base64url') },
              select: { id: true, webAuthnUserHandle: true },
            });
      if (alias === 'recovery') {
        // A real expired recovery token, separate from invitation confirmation.
        // Never used on production or by other test accounts.
        await db.passkeyRecoveryRequest.create({
          data: {
            userId: user.id,
            tokenHash: hashEmailVerificationToken('R'.repeat(43)),
            emailHash: createHash('sha256').update(email).digest('hex'),
            expiresAt: new Date(Date.now() - 60_000),
            createdAt: new Date(Date.now() - 2 * 60 * 60_000),
          },
        });
      }
      const credentials: { id: string; privateKey: string }[] = [];
      for (let i = 0; i < count; i++) {
        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const jwk = publicKey.export({ format: 'jwk' });
        const x = Buffer.from(jwk.x!, 'base64url');
        const y = Buffer.from(jwk.y!, 'base64url');
        // COSE_Key: EC2 / ES256 / P-256 / x / y (RFC 9052, RFC 9053).
        const cose = Buffer.concat([
          Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
          x,
          Buffer.from([0x22, 0x58, 0x20]),
          y,
        ]);
        const credentialId = randomBytes(32).toString('base64url');
        await db.passkeyCredential.create({
          data: {
            userId: user.id,
            credentialId,
            publicKey: cose,
            signCount: BigInt(0),
            deviceType: 'singleDevice',
            backedUp: false,
            transports: ['internal'],
          },
        });
        credentials.push({
          id: credentialId,
          privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
        });
      }
      passkeys[alias] = { userHandle: user.webAuthnUserHandle!, credentials };
    }
    writeFileSync(passkeyFile, JSON.stringify(passkeys), { mode: 0o600 });
    process.stdout.write('BILLOK_QA_AUTH_INVITE_RU=' + ruCode + '\n');
    process.stdout.write('BILLOK_QA_AUTH_INVITE_SU=' + suCode + '\n');
    process.stdout.write('BILLOK_QA_EXPIRED_CONFIRM=' + expiredToken + '\n');
  } finally {
    await db.$disconnect();
  }
}
main().catch((error: unknown) => {
  console.error('Disposable auth journey fixtures failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
