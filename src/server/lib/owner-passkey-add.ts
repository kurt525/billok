import { createHash } from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import { AppError } from './app-error';
import { assertPasskeyEnrollmentCapacity } from './passkey-account-limit';
import { hashWebAuthnBinding } from './webauthn-registration';
import { consumeOwnerPasskeyActionProof } from './owner-passkey-action-approval';
import {
  readBillokWebAuthnRelyingParty,
  WEBAUTHN_CHALLENGE_TTL_MS,
  WEBAUTHN_PASSKEY_POLICY,
} from './webauthn-relying-party';

export const OWNER_ADD_BINDING_COOKIE = 'billok-owner-passkey-add';
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
type Env = Readonly<Record<string, string | undefined>>;

function requireToken(token: unknown): string {
  if (typeof token !== 'string' || !SECRET.test(token)) throw new AppError('FORBIDDEN');
  return digest(token);
}

function clientChallenge(response: RegistrationResponseJSON): string {
  try {
    const data = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')) as {
      challenge?: unknown;
    };
    if (typeof data.challenge !== 'string' || !SECRET.test(data.challenge)) throw new Error('bad challenge');
    return digest(data.challenge);
  } catch {
    throw new AppError('FORBIDDEN');
  }
}

export async function beginAdditionalOwnerPasskey(input: {
  db: PrismaClient;
  userId: string;
  sessionHash: string;
  bindingSecret: string;
  approvalToken: unknown;
  env?: Env;
  now?: Date;
}) {
  if (!input.userId || !HASH.test(input.sessionHash)) throw new AppError('FORBIDDEN');
  const tokenHash = requireToken(input.approvalToken);
  const bindingHash = hashWebAuthnBinding(input.bindingSecret);
  const now = input.now ?? new Date();
  const proof = await input.db.ownerPasskeyActionProof.findUnique({
    where: { tokenHash },
  });
  if (
    !proof ||
    proof.userId !== input.userId ||
    proof.action !== 'ADD' ||
    proof.targetCredentialRowId !== null ||
    proof.consumedAt ||
    proof.expiresAt <= now ||
    proof.sessionBindingHash !== input.sessionHash
  ) {
    throw new AppError('FORBIDDEN');
  }
  const [owner, user, keys] = await Promise.all([
    input.db.ownerBootstrap.findUnique({ where: { id: 1 }, select: { userId: true, completedAt: true } }),
    input.db.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        email: true,
        name: true,
        webAuthnUserHandle: true,
        emailVerified: true,
        suspendedAt: true,
        isPlaceholder: true,
        sessionSecurityVersion: true,
      },
    }),
    input.db.passkeyCredential.findMany({
      where: { userId: input.userId, revokedAt: null },
      select: { id: true, credentialId: true, transports: true },
      take: 4,
    }),
  ]);
  if (
    !owner?.completedAt ||
    owner.userId !== input.userId ||
    !user?.emailVerified ||
    user.suspendedAt ||
    user.isPlaceholder ||
    !user.webAuthnUserHandle ||
    user.sessionSecurityVersion !== proof.sessionSecurityVersion ||
    keys.length < 1 ||
    keys.length >= 3 ||
    !keys.some((key) => key.id === proof.signerCredentialRowId)
  ) {
    throw new AppError('FORBIDDEN');
  }
  const rp = readBillokWebAuthnRelyingParty(input.env ?? process.env);
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpId,
    userID: new Uint8Array(Buffer.from(user.webAuthnUserHandle, 'base64url')),
    userName: user.email,
    userDisplayName: user.name ?? user.email,
    attestationType: WEBAUTHN_PASSKEY_POLICY.attestationType,
    authenticatorSelection: {
      residentKey: WEBAUTHN_PASSKEY_POLICY.residentKey,
      userVerification: WEBAUTHN_PASSKEY_POLICY.userVerification,
    },
    excludeCredentials: keys.map((key) => ({
      id: key.credentialId,
      transports: key.transports as ('usb' | 'nfc' | 'ble' | 'internal' | 'hybrid')[],
    })),
    timeout: WEBAUTHN_CHALLENGE_TTL_MS,
  });
  await input.db.webAuthnChallenge.create({
    data: {
      userId: input.userId,
      purpose: 'ADD_KEY',
      challengeHash: digest(options.challenge),
      bindingHash,
      sessionBindingHash: input.sessionHash,
      approvalProofTokenHash: tokenHash,
      expiresAt: new Date(now.getTime() + WEBAUTHN_CHALLENGE_TTL_MS),
    },
  });
  return options;
}

export async function finishAdditionalOwnerPasskey(input: {
  db: PrismaClient;
  userId: string;
  sessionHash: string;
  bindingSecret: string;
  approvalToken: unknown;
  response: RegistrationResponseJSON;
  env?: Env;
  now?: Date;
}): Promise<{ registered: true; activePasskeys: number }> {
  if (!input.userId || !HASH.test(input.sessionHash)) throw new AppError('FORBIDDEN');
  const tokenHash = requireToken(input.approvalToken);
  const bindingHash = hashWebAuthnBinding(input.bindingSecret);
  const challengeHash = clientChallenge(input.response);
  const now = input.now ?? new Date();
  const challenge = await input.db.webAuthnChallenge.findUnique({ where: { challengeHash } });
  if (
    !challenge ||
    challenge.userId !== input.userId ||
    challenge.purpose !== 'ADD_KEY' ||
    challenge.bindingHash !== bindingHash ||
    challenge.sessionBindingHash !== input.sessionHash ||
    challenge.approvalProofTokenHash !== tokenHash ||
    challenge.usedAt ||
    challenge.expiresAt <= now
  )
    throw new AppError('FORBIDDEN');
  const rp = readBillokWebAuthnRelyingParty(input.env ?? process.env);
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: (value) => digest(value) === challengeHash,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserPresence: true,
      requireUserVerification: true,
    });
  } catch {
    throw new AppError('FORBIDDEN');
  }
  if (!verified.verified || !verified.registrationInfo.userVerified) throw new AppError('FORBIDDEN');
  const { credential, credentialDeviceType, credentialBackedUp, aaguid } = verified.registrationInfo;
  if (
    !credential.id ||
    credential.id.length > 512 ||
    !credential.publicKey.length ||
    !Number.isSafeInteger(credential.counter) ||
    credential.counter < 0
  )
    throw new AppError('FORBIDDEN');
  try {
    return await input.db.$transaction(async (tx) => {
      // Locks User BEFORE checking slots and proof. A competing enrollment
      // cannot take the third slot, and a recovery cannot invalidate proof
      // midway through registration.
      const capacity = await assertPasskeyEnrollmentCapacity(tx, input.userId, 'OWNER_ADDITIONAL');
      const ownerAccount = await tx.user.findUnique({
        where: { id: input.userId },
        select: { emailVerified: true, suspendedAt: true, isPlaceholder: true },
      });
      if (
        !ownerAccount?.emailVerified ||
        ownerAccount.suspendedAt ||
        ownerAccount.isPlaceholder ||
        capacity.activeCount < 1
      )
        throw new AppError('FORBIDDEN');
      await consumeOwnerPasskeyActionProof(tx, {
        userId: input.userId,
        sessionHash: input.sessionHash,
        action: 'ADD',
        approvalToken: input.approvalToken,
        targetId: null,
        now,
      });
      const consumed = await tx.webAuthnChallenge.updateMany({
        where: {
          id: challenge.id,
          userId: input.userId,
          purpose: 'ADD_KEY',
          challengeHash,
          bindingHash,
          sessionBindingHash: input.sessionHash,
          approvalProofTokenHash: tokenHash,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) throw new AppError('FORBIDDEN');
      const duplicate = await tx.passkeyCredential.findUnique({
        where: { credentialId: credential.id },
        select: { id: true },
      });
      if (duplicate) throw new AppError('CONFLICT');
      const created = await tx.passkeyCredential.create({
        data: {
          userId: input.userId,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey),
          signCount: BigInt(credential.counter),
          transports: credential.transports ?? [],
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
          aaguid,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          adminId: input.userId,
          action: 'OWNER_PASSKEY_ADDED',
          metadata: {
            credentialRowId: created.id,
            activePasskeys: capacity.activeCount + 1,
            method: 'existing-signed-passkey-approval',
          },
        },
      });
      return { registered: true as const, activePasskeys: capacity.activeCount + 1 };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError('CONFLICT');
    }
    throw error;
  }
}
