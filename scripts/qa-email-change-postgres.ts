/** Real PostgreSQL atomicity/race regression, only on disposable billokqa.
 * WebAuthn and actual SMTP delivery are exercised separately in Chromium.
 * Here seed the already-approved request state to isolate commit races. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { assertDisposableQaDatabase } from './qa-fixture-database';
import { completeEmailChange, emailChangeDigest, cancelEmailChange } from '../src/server/lib/email-change';
import { decryptEmailChangeRecipient } from '../src/server/lib/email-change-notification';

async function main() {
  const url = assertDisposableQaDatabase(process.env);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }), errorFormat: 'minimal' });
  const env = { AUTH_SECRET: randomBytes(32).toString('hex') };
  const users: string[] = [];
  const groups: string[] = [];
  const receipts: string[] = [];
  const nonce = randomBytes(8).toString('hex');
  try {
    const owner = await db.ownerBootstrap.findUniqueOrThrow({ where: { id: 1 } });
    assert.ok(owner.completedAt);
    async function create(index: number) {
      const user = await db.user.create({
        data: {
          email: 'qa-race-' + nonce + '-' + index + '@mail.ru',
          name: 'QA Email Race',
          emailVerified: new Date(),
          registrationEmailVerificationRequired: true,
          webAuthnUserHandle: randomBytes(32).toString('base64url'),
          sbpPhone: '79991234567',
          sbpBankId: 'tbank',
        },
      });
      users.push(user.id);
      const key = await db.passkeyCredential.create({
        data: {
          userId: user.id,
          credentialId: randomBytes(32).toString('base64url'),
          publicKey: Buffer.from([1, 2, 3]),
          deviceType: 'singleDevice',
          backedUp: false,
        },
      });
      const group = await db.group.create({
        data: { name: 'Email Change QA', members: { create: { userId: user.id, role: 'ADMIN' } } },
      });
      groups.push(group.id);
      const receipt = await db.receipt.create({
        data: {
          groupId: group.id,
          uploadedById: user.id,
          savedById: user.id,
          paidById: user.id,
          items: { create: { name: 'QA receipt item', quantity: 1, unitPrice: 12550, totalPrice: 12550 } },
        },
        include: { items: true },
      });
      receipts.push(receipt.id);
      const expense = await db.expense.create({
        data: {
          groupId: group.id,
          receiptId: receipt.id,
          title: 'QA expense',
          amount: 12550,
          paidById: user.id,
          addedById: user.id,
          shares: { create: { userId: user.id, amount: 12550 } },
        },
        include: { shares: true },
      });
      const token = randomBytes(32).toString('base64url');
      const session = {
        userId: user.id,
        version: user.sessionSecurityVersion,
        binding: randomBytes(32).toString('hex'),
      };
      return { user, key, group, receipt, expense, token, session };
    }
    const a = await create(1),
      b = await create(2),
      c = await create(3);
    async function approve(x: typeof a, newEmail: string, expired = false) {
      const now = new Date();
      return db.emailChangeRequest.create({
        data: {
          userId: x.user.id,
          oldEmailHash: emailChangeDigest(x.user.email),
          newEmail,
          sessionBindingHash: x.session.binding,
          sessionSecurityVersion: x.session.version,
          challengeHash: emailChangeDigest(randomBytes(32).toString('base64url')),
          signerCredentialRowId: x.key.id,
          tokenHash: emailChangeDigest(x.token),
          approvedAt: now,
          challengeExpiresAt: now,
          expiresAt: new Date(now.getTime() + (expired ? -1 : 30 * 60_000)),
        },
      });
    }
    const target = 'qa-race-' + nonce + '@mail.su';
    await approve(a, target);
    await approve(b, target);
    const oldRecovery = await db.passkeyRecoveryRequest.create({
      data: {
        userId: a.user.id,
        tokenHash: randomBytes(32).toString('hex'),
        emailHash: emailChangeDigest(a.user.email),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const oldLogin = await db.passkeyLoginTicket.create({
      data: { userId: a.user.id, tokenHash: randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 60_000) },
    });
    const oldConfirm = await db.emailVerificationRequest.create({
      data: {
        userId: a.user.id,
        tokenHash: randomBytes(32).toString('hex'),
        emailHash: emailChangeDigest(a.user.email),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await assert.rejects(
      completeEmailChange({ db, session: { ...a.session, binding: b.session.binding }, token: a.token, env }),
      { code: 'FORBIDDEN' },
    );
    const results = await Promise.allSettled([
      completeEmailChange({ db, session: a.session, token: a.token, env }),
      completeEmailChange({ db, session: a.session, token: a.token, env }),
      completeEmailChange({ db, session: b.session, token: b.token, env }),
    ]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    const rows = await db.user.findMany({ where: { id: { in: [a.user.id, b.user.id] } } });
    const winner = rows.find((x) => x.email === target)!;
    assert.ok(winner);
    const x = winner.id === a.user.id ? a : b;
    const loser = winner.id === a.user.id ? b : a;
    assert.equal(winner.sessionSecurityVersion, x.user.sessionSecurityVersion + 1);
    assert.equal(winner.webAuthnUserHandle, x.user.webAuthnUserHandle);
    assert.equal(winner.sbpPhone, x.user.sbpPhone);
    assert.equal(winner.sbpBankId, x.user.sbpBankId);
    assert.equal(winner.name, x.user.name);
    assert.equal((await db.passkeyCredential.findUniqueOrThrow({ where: { id: x.key.id } })).revokedAt, null);
    assert.equal(await db.groupMember.count({ where: { userId: x.user.id, groupId: x.group.id } }), 1);
    assert.deepEqual(
      await db.receipt.findUniqueOrThrow({ where: { id: x.receipt.id }, include: { items: true } }),
      x.receipt,
    );
    assert.deepEqual(
      await db.expense.findUniqueOrThrow({ where: { id: x.expense.id }, include: { shares: true } }),
      x.expense,
    );
    assert.equal(await db.emailChangeRequest.count({ where: { userId: x.user.id } }), 0);
    const notice = await db.emailChangeNotification.findFirstOrThrow({ where: { userId: x.user.id } });
    assert.equal(decryptEmailChangeRecipient(notice.encryptedRecipient, notice.id, env), x.user.email);
    assert.ok(!notice.encryptedRecipient.includes(x.user.email));
    assert.equal(
      await db.securityEvent.count({
        where: { actorId: x.user.id, action: 'EMAIL_CHANGE_COMPLETED', outcome: 'ALLOWED' },
      }),
      1,
    );
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: loser.user.id } })).email, loser.user.email);
    assert.equal(await db.emailChangeNotification.count({ where: { userId: loser.user.id } }), 0);
    if (winner.id === a.user.id) {
      assert.ok((await db.passkeyRecoveryRequest.findUniqueOrThrow({ where: { id: oldRecovery.id } })).consumedAt);
      assert.equal(await db.passkeyLoginTicket.count({ where: { id: oldLogin.id } }), 0);
      assert.ok((await db.emailVerificationRequest.findUniqueOrThrow({ where: { id: oldConfirm.id } })).consumedAt);
    } else {
      // The loser retains its previous proofs. Complete it on a distinct
      // address and explicitly prove the old proofs are invalidated.
      await db.emailChangeRequest.update({
        where: { userId: a.user.id },
        data: { newEmail: 'qa-race-other-' + nonce + '@mail.ru' },
      });
      await completeEmailChange({ db, session: a.session, token: a.token, env });
      assert.ok((await db.passkeyRecoveryRequest.findUniqueOrThrow({ where: { id: oldRecovery.id } })).consumedAt);
      assert.equal(await db.passkeyLoginTicket.count({ where: { id: oldLogin.id } }), 0);
      assert.ok((await db.emailVerificationRequest.findUniqueOrThrow({ where: { id: oldConfirm.id } })).consumedAt);
    }
    await assert.rejects(completeEmailChange({ db, session: x.session, token: x.token, env }), { code: 'FORBIDDEN' });
    await approve(c, 'qa-expired-' + nonce + '@mail.ru', true);
    await assert.rejects(completeEmailChange({ db, session: c.session, token: c.token, env }), { code: 'FORBIDDEN' });
    await cancelEmailChange({ db, session: c.session, env });
    assert.equal(await db.emailChangeRequest.count({ where: { userId: c.user.id } }), 0);
    // Race a real new User insertion for a case variant against completion.
    const raceEmail = 'qa-register-race-' + nonce + '@mail.ru';
    await approve(c, raceEmail);
    const registrationId = randomUUID();
    users.push(registrationId);
    const registration = await Promise.allSettled([
      completeEmailChange({ db, session: c.session, token: c.token, env }),
      db.user.create({ data: { id: registrationId, email: raceEmail.toUpperCase(), name: 'QA race registration' } }),
    ]);
    assert.equal(registration.filter((x) => x.status === 'fulfilled').length, 1);
    const matching = await db.$queryRaw<
      { count: bigint }[]
    >`SELECT COUNT(*) AS count FROM "User" WHERE lower(email)=lower(${raceEmail})`;
    assert.equal(matching[0]!.count, BigInt(1));
    const ownerAccount = await db.user.findUniqueOrThrow({ where: { id: owner.userId } });
    await assert.rejects(
      completeEmailChange({
        db,
        session: { userId: owner.userId, version: ownerAccount.sessionSecurityVersion, binding: c.session.binding },
        token: c.token,
        env,
      }),
      { code: 'FORBIDDEN' },
    );
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: owner.userId } })).email, ownerAccount.email);
    console.log('REAL_POSTGRES_EMAIL_CHANGE_RACES_SINGLE_USE_IDENTITY=PASS');
  } finally {
    await db.securityEvent.deleteMany({ where: { actorId: { in: users } } });
    await db.group.deleteMany({ where: { id: { in: groups } } });
    await db.receipt.deleteMany({ where: { id: { in: receipts } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  }
}
// The shared rate limiter owns a process timer. This is a one-shot QA
// command, and main() has already awaited all cleanup and disconnection.
main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('Email change race test failed:', error instanceof Error ? error.name : 'unknown');
    process.exit(1);
  },
);
