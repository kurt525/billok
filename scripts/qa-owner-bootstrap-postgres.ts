/**
 * Disposable PostgreSQL integration check. Never point at a real BillOK
 * database; this creates a temporary owner and verifies the singleton lock,
 * private invitation, email confirmation, and Passkey-only state.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { createEmailVerificationToken } from '../src/server/lib/email-verification-token';
import { AppError } from '../src/server/lib/app-error';
import { confirmRegistrationEmail } from '../src/server/lib/registration-email-confirmation';
import {
  canRetryOwnerInitialPasskey,
  createInitialOwner,
  OWNER_BOOTSTRAP_SINGLETON_ID,
} from '../src/server/lib/owner-bootstrap';
import { SYSTEM_INVITE_TTL_MS } from '../src/server/lib/system-invite-lifetime';

async function main() {
  if (process.env.BILLOK_QA_DISPOSABLE_DB !== 'I_ACKNOWLEDGE_DISPOSABLE_DB') {
    throw new Error('This script is ONLY allowed on a disposable QA database');
  }
  const url = process.env.DATABASE_URL;
  if (!url || !/^postgresql:\/\/[^/]+@127\.0\.0\.1:[0-9]+\/billokqa(?:\?|$)/.test(url)) {
    throw new Error('A disposable local-only billokqa DATABASE_URL is required');
  }
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const now = new Date();
  const ownerEmail = 'qa-owner-' + randomBytes(6).toString('hex') + '@example.ru';
  const env = {
    BILLOK_OWNER_BOOTSTRAP_ACK: 'CREATE_INITIAL_OWNER',
    ADMIN_EMAIL: ownerEmail,
    EMAIL_SERVER_HOST: 'smtp.example.ru',
    EMAIL_SERVER_PORT: '465',
    EMAIL_SERVER_USER: 'noreply@billok.ru',
    EMAIL_SERVER_PASSWORD: 'qa-not-real',
    NEXTAUTH_URL: 'https://billok.ru',
    NODE_ENV: 'production',
  };
  let ownerId: string | null = null;
  try {
    assert.equal(await db.user.count(), 0, 'Only a fresh DB is safe for bootstrap');
    const owner = await createInitialOwner({ db, env, now });
    ownerId = owner.userId;
    assert.equal(owner.email, ownerEmail);
    const user = await db.user.findUniqueOrThrow({ where: { id: owner.userId } });
    assert.equal(user.passwordHash, null);
    assert.equal(user.emailVerified, null);
    assert.equal(user.registrationEmailVerificationRequired, true);
    const invite = await db.systemInvite.findFirstOrThrow({ where: { reservedById: user.id } });
    assert.equal(invite.usedById, null);
    assert.ok(invite.reservedUntil && invite.reservedUntil > now);
    assert.ok(invite.expiresAt && invite.expiresAt > now);
    assert.ok(invite.expiresAt && invite.expiresAt <= new Date(now.getTime() + SYSTEM_INVITE_TTL_MS + 10_000));
    const state = await db.ownerBootstrap.findUniqueOrThrow({ where: { id: OWNER_BOOTSTRAP_SINGLETON_ID } });
    assert.equal(state.userId, user.id);
    assert.equal(state.completedAt, null);
    await assert.rejects(
      createInitialOwner({ db, env, now }),
      (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN',
    );
    assert.equal(await db.user.count(), 1, 'second attempt must not create another owner');
    const { token, tokenHash, expiresAt } = createEmailVerificationToken(now);
    await db.emailVerificationRequest.create({ data: { userId: user.id, tokenHash, expiresAt } });
    assert.equal(await confirmRegistrationEmail(db, token, now), true);
    assert.equal(await confirmRegistrationEmail(db, token, now), false);
    assert.ok((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified);
    assert.equal((await db.systemInvite.findUniqueOrThrow({ where: { id: invite.id } })).usedById, user.id);
    assert.equal(await canRetryOwnerInitialPasskey(db, user.id, tokenHash, now), true);
    assert.equal(await canRetryOwnerInitialPasskey(db, 'another-user', tokenHash, now), false);
    assert.equal(await db.passkeyCredential.count({ where: { userId: user.id } }), 0);
    assert.equal(
      await db.adminAuditLog.count({
        where: { adminId: user.id, action: 'OWNER_BOOTSTRAP_STARTED' },
      }),
      1,
    );
    console.log('POSTGRES_OWNER_BOOTSTRAP=PASS');
  } finally {
    if (ownerId) {
      await db.ownerBootstrap.deleteMany({ where: { userId: ownerId } });
      await db.adminAuditLog.deleteMany({ where: { adminId: ownerId } });
      await db.emailVerificationRequest.deleteMany({ where: { userId: ownerId } });
      await db.systemInvite.deleteMany({ where: { OR: [{ usedById: ownerId }, { reservedById: ownerId }] } });
      await db.user.deleteMany({ where: { id: ownerId } });
    }
    await db.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.name + ': ' + error.message : 'QA owner bootstrap failed');
  process.exitCode = 1;
});
