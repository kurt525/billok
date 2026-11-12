import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient, Prisma } from '@/generated/prisma/client';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import {
  beginOwnerPasskeyActionApproval,
  finishOwnerPasskeyActionApproval,
  consumeOwnerPasskeyActionProof,
  ownerSessionFingerprint,
  OWNER_APPROVAL_TICKET_TTL_MS,
} from './owner-passkey-action-approval';
import { hashWebAuthnBinding } from './webauthn-registration';

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));

const now = new Date('2026-11-12T12:00:00.000Z');
const secret = 'b'.repeat(43);
const challenge = 'q'.repeat(43);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sessionHash = hash('authjs.session-token=owner-A');
const otherSession = hash('authjs.session-token=owner-B');
const bindingHash = hash(sessionHash + ':' + hashWebAuthnBinding(secret));
const env = { NODE_ENV: 'production' };
const signed = {
  id: 'credential-keep',
  rawId: 'credential-keep',
  type: 'public-key',
  response: {
    clientDataJSON: Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge,
        origin: 'https://billok.ru',
      }),
    ).toString('base64url'),
    authenticatorData: '',
    signature: '',
  },
} as AuthenticationResponseJSON;

function fixture(n = 2, action: 'ADD' | 'RENAME' | 'REVOKE' = 'REVOKE') {
  const owner = { userId: 'owner', completedAt: now as Date | null };
  const user = {
    emailVerified: now,
    suspendedAt: null as Date | null,
    isPlaceholder: false,
    sessionSecurityVersion: 2,
  };
  const keys = [
    {
      id: 'key-lost',
      credentialId: 'credential-lost',
      transports: ['internal'],
      userId: 'owner',
      signCount: BigInt(3),
      revokedAt: null as Date | null,
      publicKey: Buffer.from([1, 2, 3]),
    },
    {
      id: 'key-keep',
      credentialId: 'credential-keep',
      transports: ['internal'],
      userId: 'owner',
      signCount: BigInt(3),
      revokedAt: null as Date | null,
      publicKey: Buffer.from([4, 5, 6]),
    },
    {
      id: 'key-third',
      credentialId: 'credential-third',
      transports: ['internal'],
      userId: 'owner',
      signCount: BigInt(0),
      revokedAt: null as Date | null,
      publicKey: Buffer.from([7, 8, 9]),
    },
  ].slice(0, n);
  const challengeRow = {
    id: 'challenge-row',
    userId: 'owner',
    purpose: 'OWNER_APPROVAL',
    ownerActionType: action,
    targetCredentialRowId: action === 'ADD' ? null : 'key-lost',
    sessionBindingHash: sessionHash,
    bindingHash,
    challengeHash: hash(challenge),
    expiresAt: new Date(now.getTime() + 300_000),
    usedAt: null as Date | null,
  };
  const proof = {
    id: 'proof-row',
    tokenHash: '',
    userId: 'owner',
    action,
    targetCredentialRowId: challengeRow.targetCredentialRowId,
    signerCredentialRowId: 'key-keep',
    sessionBindingHash: sessionHash,
    sessionSecurityVersion: 2,
    expiresAt: new Date(now.getTime() + OWNER_APPROVAL_TICKET_TTL_MS),
    consumedAt: null as Date | null,
  };
  const db = {
    ownerBootstrap: { findUnique: vi.fn(async () => owner) },
    user: { findUnique: vi.fn(async () => user) },
    passkeyCredential: {
      findMany: vi.fn(async () => keys.filter((key) => !key.revokedAt)),
      findUnique: vi.fn(
        async ({ where }: { where: { credentialId?: string; id?: string } }) =>
          keys.find((key) => key.credentialId === where.credentialId || key.id === where.id) ?? null,
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string; signCount: bigint }; data: { signCount: bigint } }) => {
          const key = keys.find((entry) => entry.id === where.id && entry.signCount === where.signCount);
          if (!key) return { count: 0 };
          key.signCount = data.signCount;
          return { count: 1 };
        },
      ),
    },
    webAuthnChallenge: {
      create: vi.fn().mockResolvedValue({ id: challengeRow.id }),
      findUnique: vi.fn(async () => challengeRow),
      updateMany: vi.fn(async () => {
        if (challengeRow.usedAt) return { count: 0 };
        challengeRow.usedAt = now;
        return { count: 1 };
      }),
    },
    ownerPasskeyActionProof: {
      create: vi.fn(async ({ data }: { data: { tokenHash: string } }) => {
        proof.tokenHash = data.tokenHash;
        return proof;
      }),
      findUnique: vi.fn(async () => proof),
      updateMany: vi.fn(async () => {
        if (proof.consumedAt) return { count: 0 };
        proof.consumedAt = now;
        return { count: 1 };
      }),
    },
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: 'owner' }]),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
  };
  return { db, owner, user, keys, challengeRow, proof };
}
const asDb = (db: ReturnType<typeof fixture>['db']) => db as unknown as PrismaClient;
const asTx = (db: ReturnType<typeof fixture>['db']) => db as unknown as Prisma.TransactionClient;
function begin(
  db: ReturnType<typeof fixture>['db'],
  action: 'ADD' | 'RENAME' | 'REVOKE' = 'REVOKE',
  targetId: string | null = 'key-lost',
  sess = sessionHash,
) {
  return beginOwnerPasskeyActionApproval({
    db: asDb(db),
    userId: 'owner',
    sessionHash: sess,
    bindingSecret: secret,
    action,
    targetId,
    env,
    now,
  });
}
function finish(
  db: ReturnType<typeof fixture>['db'],
  sess = sessionHash,
  response = signed,
  userId = 'owner',
  secretOverride = secret,
) {
  return finishOwnerPasskeyActionApproval({
    db: asDb(db),
    userId,
    sessionHash: sess,
    bindingSecret: secretOverride,
    response,
    env,
    now,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateAuthenticationOptions).mockResolvedValue({
    challenge,
    rpId: 'billok.ru',
    timeout: 300_000,
    userVerification: 'required',
  });
  vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
    verified: true,
    authenticationInfo: {
      credentialID: signed.id,
      userVerified: true,
      newCounter: 4,
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
      origin: 'https://billok.ru',
      rpID: 'billok.ru',
    },
  });
});

describe('Issue #1 6.10.2.2: fresh owner WebAuthn approval', () => {
  it('fingerprints Auth.js JWT cookies including chunks, rejecting mixed or missing cookies', () => {
    expect(ownerSessionFingerprint(new Headers({ cookie: 'authjs.session-token=owner-A; next=ok' }))).toBe(sessionHash);
    expect(ownerSessionFingerprint(new Headers({ cookie: '__Secure-authjs.session-token=owner-B' }))).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(
      ownerSessionFingerprint(
        new Headers({
          cookie: 'authjs.session-token.1=bar;authjs.session-token.0=foo',
        }),
      ),
    ).toBe(
      ownerSessionFingerprint(
        new Headers({
          cookie: 'authjs.session-token.0=foo;authjs.session-token.1=bar',
        }),
      ),
    );
    for (const cookie of [
      '',
      'sharetab-impersonate=abc',
      'authjs.session-token=one;authjs.session-token=two',
      'authjs.session-token.1=only',
      'authjs.session-token=plain;__Secure-authjs.session-token=other',
    ]) {
      expect(() => ownerSessionFingerprint(new Headers({ cookie }))).toThrow();
    }
  });

  it('issues an action-specific challenge for ADD, RENAME and REVOKE without login tickets', async () => {
    for (const action of ['ADD', 'RENAME', 'REVOKE'] as const) {
      const { db } = fixture(2, action);
      const target = action === 'ADD' ? null : 'key-lost';
      expect(await begin(db, action, target)).toMatchObject({ challenge });
      const allowed = vi.mocked(generateAuthenticationOptions).mock.lastCall?.[0];
      expect(allowed?.userVerification).toBe('required');
      expect(allowed?.allowCredentials?.map((item) => item.id)).toEqual(
        action === 'REVOKE' ? ['credential-keep'] : ['credential-lost', 'credential-keep'],
      );
      expect(db.webAuthnChallenge.create).toHaveBeenCalledWith({
        data: {
          purpose: 'OWNER_APPROVAL',
          ownerActionType: action,
          userId: 'owner',
          targetCredentialRowId: target,
          sessionBindingHash: sessionHash,
          bindingHash,
          challengeHash: hash(challenge),
          expiresAt: new Date(now.getTime() + 300_000),
        },
      });
      expect(db.ownerPasskeyActionProof.create).not.toHaveBeenCalled();
    }
  });

  it('rejects ordinary users, unconfirmed owner, suspended account and empty keys', async () => {
    for (const patch of [
      { userId: 'stranger', completedAt: now },
      { userId: 'owner', completedAt: null },
    ]) {
      const { db, owner } = fixture();
      Object.assign(owner, patch);
      await expect(begin(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.webAuthnChallenge.create).not.toHaveBeenCalled();
    }
    for (const patch of [{ emailVerified: null }, { suspendedAt: now }, { isPlaceholder: true }]) {
      const { db, user } = fixture();
      Object.assign(user, patch);
      await expect(begin(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    const { db } = fixture(0);
    await expect(begin(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('enforces max-3, owner-only target and never permits revocation of the last key', async () => {
    const one = fixture(1);
    await expect(begin(one.db, 'REVOKE', 'key-lost')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const three = fixture(3);
    await expect(begin(three.db, 'ADD', null)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const other = fixture(2);
    await expect(begin(other.db, 'RENAME', 'other-account-key')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const bad = fixture(2);
    await expect(begin(bad.db, 'ADD', 'key-lost')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses replayed, expired, wrong session and different-browser challenges', async () => {
    for (const patch of [
      { usedAt: now },
      { expiresAt: now },
      { purpose: 'LOGIN' },
      { userId: 'stranger' },
      { sessionBindingHash: otherSession },
      { bindingHash: hash('different-binding') },
    ]) {
      const { db, challengeRow } = fixture();
      Object.assign(challengeRow, patch);
      await expect(finish(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
    }
    const { db } = fixture();
    await expect(finish(db, otherSession)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('checks signed RP ID, origin, UV, signer public key and counter, then creates ONE scoped proof', async () => {
    const { db, keys, proof } = fixture();
    const result = await finish(db);
    expect(result.expiresInSeconds).toBe(120);
    expect(result.approvalToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', 'owner');
    const args = vi.mocked(verifyAuthenticationResponse).mock.calls[0]![0];
    expect(args).toMatchObject({
      expectedOrigin: 'https://billok.ru',
      expectedRPID: 'billok.ru',
      requireUserVerification: true,
      credential: {
        id: 'credential-keep',
        publicKey: new Uint8Array([4, 5, 6]),
        counter: 3,
      },
    });
    if (typeof args.expectedChallenge !== 'function') throw new Error('Missing signed challenge validator');
    expect(await args.expectedChallenge(challenge)).toBe(true);
    expect(await args.expectedChallenge('x'.repeat(43))).toBe(false);
    expect(keys[1]?.signCount).toBe(BigInt(4));
    expect(db.ownerPasskeyActionProof.create).toHaveBeenCalledWith({
      data: {
        userId: 'owner',
        action: 'REVOKE',
        targetCredentialRowId: 'key-lost',
        signerCredentialRowId: 'key-keep',
        tokenHash: hash(result.approvalToken),
        sessionBindingHash: sessionHash,
        sessionSecurityVersion: 2,
        expiresAt: new Date(now.getTime() + 120_000),
      },
    });
    expect(proof.tokenHash).toBe(hash(result.approvalToken));
    expect(JSON.stringify(db.ownerPasskeyActionProof.create.mock.calls)).not.toContain(result.approvalToken);
  });

  it('prevents signing with the key being revoked or a foreign/revoked signer', async () => {
    for (const id of ['credential-lost', 'foreign-credential']) {
      const { db } = fixture();
      await expect(finish(db, sessionHash, { ...signed, id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.ownerPasskeyActionProof.create).not.toHaveBeenCalled();
    }
    const { db, keys } = fixture();
    keys[1]!.revokedAt = now;
    await expect(finish(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('fails closed on invalid signature, missing UV or replayed hardware counter', async () => {
    const invalid = fixture();
    vi.mocked(verifyAuthenticationResponse).mockRejectedValueOnce(new Error('bad signature'));
    await expect(finish(invalid.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const result of [
      { verified: false, authenticationInfo: { userVerified: true, credentialID: signed.id, newCounter: 4 } },
      { verified: true, authenticationInfo: { userVerified: false, credentialID: signed.id, newCounter: 4 } },
      { verified: true, authenticationInfo: { userVerified: true, credentialID: signed.id, newCounter: 3 } },
    ]) {
      const { db } = fixture();
      vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce(
        result as Awaited<ReturnType<typeof verifyAuthenticationResponse>>,
      );
      await expect(finish(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.ownerPasskeyActionProof.create).not.toHaveBeenCalled();
    }
  });

  it('a competing challenge completion cannot mint two approvals', async () => {
    const { db } = fixture();
    db.webAuthnChallenge.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(finish(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.ownerPasskeyActionProof.create).not.toHaveBeenCalled();
    expect(db.passkeyCredential.updateMany).not.toHaveBeenCalled();
  });

  it('consumes a proof once for exactly its action, target, session and owner', async () => {
    const { db, proof } = fixture();
    const approvalToken = (await finish(db)).approvalToken;
    const consume = (patch: Partial<Parameters<typeof consumeOwnerPasskeyActionProof>[1]> = {}) =>
      consumeOwnerPasskeyActionProof(asTx(db), {
        userId: 'owner',
        sessionHash,
        approvalToken,
        action: 'REVOKE',
        targetId: 'key-lost',
        now,
        ...patch,
      });
    for (const patch of [
      { userId: 'another-user' },
      { sessionHash: otherSession },
      { action: 'RENAME' as const },
      { targetId: 'another-key' },
      { targetId: null },
    ]) {
      await expect(consume(patch)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(proof.consumedAt).toBeNull();
    await expect(consume()).resolves.toBeUndefined();
    expect(db.ownerPasskeyActionProof.updateMany).toHaveBeenCalledTimes(1);
    await expect(consume()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('fails closed when another concurrent operation consumes the same proof', async () => {
    const { db } = fixture();
    const token = (await finish(db)).approvalToken;
    db.ownerPasskeyActionProof.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      consumeOwnerPasskeyActionProof(asTx(db), {
        userId: 'owner',
        sessionHash,
        approvalToken: token,
        action: 'REVOKE',
        targetId: 'key-lost',
        now,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('invalidates approval after session version change, key revoke or expiry', async () => {
    for (const change of ['session', 'key', 'expired'] as const) {
      const { db, user, keys, proof } = fixture();
      const token = (await finish(db)).approvalToken;
      if (change === 'session') user.sessionSecurityVersion++;
      if (change === 'key') keys[1]!.revokedAt = now;
      if (change === 'expired') proof.expiresAt = now;
      await expect(
        consumeOwnerPasskeyActionProof(asTx(db), {
          userId: 'owner',
          sessionHash,
          approvalToken: token,
          action: 'REVOKE',
          targetId: 'key-lost',
          now,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.ownerPasskeyActionProof.updateMany).not.toHaveBeenCalled();
    }
  });
});
