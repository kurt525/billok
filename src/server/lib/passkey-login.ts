import { createHash, randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { type PrismaClient } from '@/generated/prisma/client';
import { AppError } from './app-error';
import { hashWebAuthnBinding } from './webauthn-registration';
import { readBillokWebAuthnRelyingParty, WEBAUTHN_CHALLENGE_TTL_MS } from './webauthn-relying-party';

export const WEBAUTHN_LOGIN_BINDING_COOKIE = 'billok-passkey-login';
export const PASSKEY_LOGIN_TICKET_TTL_MS = 60_000;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Challenge is not itself a credential; a valid signature is always required. */
export async function beginPasskeyLogin(input: {
  db: PrismaClient;
  bindingSecret: string;
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const rp = readBillokWebAuthnRelyingParty(input.env ?? process.env);
  const options = await generateAuthenticationOptions({
    rpID: rp.rpId,
    userVerification: 'required',
    timeout: WEBAUTHN_CHALLENGE_TTL_MS,
    // No allowCredentials: discoverable passkeys, no email/username enumeration.
  });
  await input.db.webAuthnChallenge.create({
    data: {
      challengeHash: sha256(options.challenge),
      bindingHash: hashWebAuthnBinding(input.bindingSecret),
      purpose: 'LOGIN',
      expiresAt: new Date(now.getTime() + WEBAUTHN_CHALLENGE_TTL_MS),
    },
  });
  return options;
}

function responseChallenge(response: AuthenticationResponseJSON): string {
  try {
    const data = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')) as {
      challenge?: unknown;
    };
    if (typeof data.challenge !== 'string' || !SECRET_PATTERN.test(data.challenge)) {
      throw new Error('Malformed WebAuthn challenge');
    }
    return data.challenge;
  } catch {
    throw new AppError('FORBIDDEN');
  }
}

export async function finishPasskeyLogin(input: {
  db: PrismaClient;
  bindingSecret: string;
  response: AuthenticationResponseJSON;
  now?: Date;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<{ loginTicket: string }> {
  const now = input.now ?? new Date();
  const bindingHash = hashWebAuthnBinding(input.bindingSecret);
  const challengeHash = sha256(responseChallenge(input.response));
  const challenge = await input.db.webAuthnChallenge.findUnique({ where: { challengeHash } });
  if (
    !challenge ||
    challenge.purpose !== 'LOGIN' ||
    challenge.bindingHash !== bindingHash ||
    challenge.usedAt ||
    challenge.expiresAt <= now
  ) {
    throw new AppError('FORBIDDEN');
  }
  // Credential ID is an untrusted lookup hint until the signature is verified.
  if (typeof input.response.id !== 'string' || input.response.id.length > 512) {
    throw new AppError('FORBIDDEN');
  }
  const passkey = await input.db.passkeyCredential.findUnique({
    where: { credentialId: input.response.id },
    include: {
      user: { select: { id: true, emailVerified: true, suspendedAt: true } },
    },
  });
  if (
    !passkey ||
    passkey.revokedAt ||
    !passkey.user.emailVerified ||
    passkey.user.suspendedAt ||
    passkey.signCount < 0 ||
    passkey.signCount > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new AppError('FORBIDDEN');
  }
  const rp = readBillokWebAuthnRelyingParty(input.env ?? process.env);
  let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verified = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: (received) => sha256(received) === challenge.challengeHash,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserVerification: true,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: Number(passkey.signCount),
        transports: passkey.transports,
      },
    });
  } catch {
    throw new AppError('FORBIDDEN');
  }
  if (
    !verified.verified ||
    !verified.authenticationInfo.userVerified ||
    verified.authenticationInfo.credentialID !== passkey.credentialId
  ) {
    throw new AppError('FORBIDDEN');
  }
  const newCounter = verified.authenticationInfo.newCounter;
  if (
    !Number.isSafeInteger(newCounter) ||
    newCounter < 0 ||
    // Single-device counters must advance; multi-device credentials may remain at zero.
    ((newCounter !== 0 || passkey.signCount !== BigInt(0)) && BigInt(newCounter) <= passkey.signCount)
  ) {
    throw new AppError('FORBIDDEN');
  }
  const ticket = randomBytes(32).toString('base64url');
  await input.db.$transaction(async (tx) => {
    // Account and credential locks serialize multiple signed responses for
    // one key, and status is checked again within the same transaction.
    await tx.$queryRawUnsafe('SELECT id FROM "PasskeyCredential" WHERE id = $1 FOR UPDATE', passkey.id);
    const current = await tx.passkeyCredential.findUnique({
      where: { id: passkey.id },
      include: {
        user: { select: { id: true, emailVerified: true, suspendedAt: true } },
      },
    });
    if (
      !current ||
      current.revokedAt ||
      !current.user.emailVerified ||
      current.user.suspendedAt ||
      current.credentialId !== passkey.credentialId ||
      current.signCount !== passkey.signCount
    ) {
      throw new AppError('FORBIDDEN');
    }
    const consumed = await tx.webAuthnChallenge.updateMany({
      where: {
        id: challenge.id,
        challengeHash,
        bindingHash,
        purpose: 'LOGIN',
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) throw new AppError('FORBIDDEN');
    const update = await tx.passkeyCredential.updateMany({
      where: { id: passkey.id, revokedAt: null, signCount: passkey.signCount },
      data: {
        signCount: BigInt(newCounter),
        lastUsedAt: now,
        deviceType: verified.authenticationInfo.credentialDeviceType,
        backedUp: verified.authenticationInfo.credentialBackedUp,
      },
    });
    if (update.count !== 1) throw new AppError('FORBIDDEN');
    await tx.passkeyLoginTicket.create({
      data: {
        tokenHash: sha256(ticket),
        userId: current.user.id,
        expiresAt: new Date(now.getTime() + PASSKEY_LOGIN_TICKET_TTL_MS),
      },
    });
  });
  return { loginTicket: ticket };
}

/** Called only by the dedicated Auth.js Passkey provider; never from an email link. */
export async function consumePasskeyLoginTicket(input: { db: PrismaClient; token: unknown; now?: Date }) {
  const now = input.now ?? new Date();
  if (typeof input.token !== 'string' || !SECRET_PATTERN.test(input.token)) return null;
  const digest = sha256(input.token);
  return input.db.$transaction(async (tx) => {
    const proof = await tx.passkeyLoginTicket.findUnique({ where: { tokenHash: digest } });
    if (!proof || proof.consumedAt || proof.expiresAt <= now) return null;
    const user = await tx.user.findUnique({
      where: { id: proof.userId },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        locale: true,
        emailVerified: true,
        suspendedAt: true,
        passkeyCredentials: { where: { revokedAt: null }, select: { id: true }, take: 1 },
      },
    });
    if (!user || !user.emailVerified || user.suspendedAt || !user.passkeyCredentials.length) {
      return null;
    }
    const result = await tx.passkeyLoginTicket.updateMany({
      where: { id: proof.id, tokenHash: digest, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (result.count !== 1) return null;
    return { id: user.id, name: user.name, email: user.email, image: user.image, locale: user.locale };
  });
}
