import { createHash, randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import { AppError } from './app-error';
import { hashWebAuthnBinding } from './webauthn-registration';
import { readBillokWebAuthnRelyingParty, WEBAUTHN_CHALLENGE_TTL_MS } from './webauthn-relying-party';

export const OWNER_APPROVAL_BINDING_COOKIE = 'billok-owner-approval';
export const OWNER_APPROVAL_TICKET_TTL_MS = 2 * 60 * 1000;
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const digest = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex');
// This is the ONLY WebAuthn-approved action allowlist. Individual privileged
// endpoints remain forbidden until they atomically redeem their exact proof.
export const OWNER_APPROVED_ACTIONS = [
  'ADD',
  'RENAME',
  'REVOKE',
  'USER_SUSPEND',
  'USER_UNSUSPEND',
  'USER_DELETE',
  'SYSTEM_INVITE_CREATE',
  'SYSTEM_INVITE_REVOKE',
  'REGISTRATION_MODE_UPDATE',
  'OWNER_SETTING_UPDATE',
  'IMPERSONATE',
  'ADMIN_EXPORT',
] as const;
export type OwnerPasskeyAction = (typeof OWNER_APPROVED_ACTIONS)[number];
type Env = Readonly<Record<string, string | undefined>>;
type Store = PrismaClient | Prisma.TransactionClient;

export function isOwnerPasskeyAction(value: unknown): value is OwnerPasskeyAction {
  return typeof value === 'string' && (OWNER_APPROVED_ACTIONS as readonly string[]).includes(value);
}

function validateAction(action: unknown): asserts action is OwnerPasskeyAction {
  if (!isOwnerPasskeyAction(action)) throw new AppError('FORBIDDEN');
}
function isCredentialAction(action: OwnerPasskeyAction): boolean {
  return action === 'ADD' || action === 'RENAME' || action === 'REVOKE';
}

/** Bind an approval to the EXACT Auth.js JWT cookie, including cookie chunks.
 * Auth.js validates the JWT separately on every endpoint; this fingerprint
 * prevents using a one-time approval in another logged-in browser session.
 */
export function ownerSessionFingerprint(headers: Headers): string {
  const cookies = (headers.get('cookie') ?? '').split(';').map((part) => part.trim());
  const matches: [string, string][] = [];
  for (const cookie of cookies) {
    const position = cookie.indexOf('=');
    if (position < 0) continue;
    const name = cookie.slice(0, position);
    const value = cookie.slice(position + 1);
    if (/^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/u.test(name)) {
      if (!value || value.length > 4096 || matches.some(([other]) => other === name)) throw new AppError('FORBIDDEN');
      matches.push([name, value]);
    }
  }
  if (!matches.length || matches.length > 16) throw new AppError('FORBIDDEN');
  const nameBase = matches[0]![0].replace(/\.\d+$/u, '');
  if (matches.some(([name]) => name.replace(/\.\d+$/u, '') !== nameBase)) throw new AppError('FORBIDDEN');
  const single = matches.length === 1 && matches[0]![0] === nameBase;
  if (!single) {
    // Sort chunk indices numerically; lexical sorting would reject chunk .10.
    matches.sort(([a], [b]) => Number(a.slice(nameBase.length + 1)) - Number(b.slice(nameBase.length + 1)));
    if (matches.some(([name], i) => name !== nameBase + '.' + i)) throw new AppError('FORBIDDEN');
  }
  return digest(matches.map(([name, value]) => name + '=' + value).join(';'));
}

function validateBinding(sessionHash: string, secret: string) {
  if (!SHA256.test(sessionHash)) throw new AppError('FORBIDDEN');
  // Reject malformed browser secrets before hashing.
  return digest(sessionHash + ':' + hashWebAuthnBinding(secret));
}

function signedChallenge(response: AuthenticationResponseJSON) {
  try {
    const parsed = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')) as {
      challenge?: unknown;
    };
    if (typeof parsed.challenge !== 'string' || !SECRET.test(parsed.challenge)) throw new Error('bad challenge');
    return digest(parsed.challenge);
  } catch {
    throw new AppError('FORBIDDEN');
  }
}

async function ownerStatus(store: Store, userId: string) {
  const [bootstrap, user, keys] = await Promise.all([
    store.ownerBootstrap.findUnique({ where: { id: 1 }, select: { userId: true, completedAt: true } }),
    store.user.findUnique({
      where: { id: userId },
      select: {
        emailVerified: true,
        suspendedAt: true,
        isPlaceholder: true,
        sessionSecurityVersion: true,
      },
    }),
    store.passkeyCredential.findMany({
      where: { userId, revokedAt: null },
      select: { id: true, credentialId: true, transports: true },
      take: 4,
    }),
  ]);
  if (
    !bootstrap?.completedAt ||
    bootstrap.userId !== userId ||
    !user?.emailVerified ||
    user.suspendedAt ||
    user.isPlaceholder ||
    keys.length < 1 ||
    keys.length > 3
  ) {
    throw new AppError('FORBIDDEN');
  }
  return { user, keys };
}

function allowedSigners(
  keys: Awaited<ReturnType<typeof ownerStatus>>['keys'],
  action: OwnerPasskeyAction,
  target: string | null,
) {
  if (isCredentialAction(action)) {
    if (
      (action === 'ADD' && (target !== null || keys.length >= 3)) ||
      (action !== 'ADD' && (!target || !keys.some((key) => key.id === target))) ||
      (action === 'REVOKE' && keys.length < 2)
    )
      throw new AppError('FORBIDDEN');
  } else if (!target || target.length > 128) {
    // Every sensitive operation must bind the exact target, including a
    // canonical fingerprint of request contents for create/update actions.
    throw new AppError('FORBIDDEN');
  }
  const signers = keys.filter((key) => action !== 'REVOKE' || key.id !== target);
  if (signers.length < 1) throw new AppError('FORBIDDEN');
  return signers;
}

export async function beginOwnerPasskeyActionApproval(input: {
  db: PrismaClient;
  userId: string;
  sessionHash: string;
  bindingSecret: string;
  action: OwnerPasskeyAction;
  targetId?: string | null;
  env?: Env;
  now?: Date;
}) {
  validateAction(input.action);
  if (
    !input.userId ||
    (input.targetId !== undefined &&
      input.targetId !== null &&
      (typeof input.targetId !== 'string' || input.targetId.length > 128))
  )
    throw new AppError('FORBIDDEN');
  const targetId = input.targetId ?? null;
  const bindingHash = validateBinding(input.sessionHash, input.bindingSecret);
  const { keys } = await ownerStatus(input.db, input.userId);
  const signers = allowedSigners(keys, input.action, targetId);
  const rp = readBillokWebAuthnRelyingParty(input.env ?? process.env);
  const options = await generateAuthenticationOptions({
    rpID: rp.rpId,
    userVerification: 'required',
    timeout: WEBAUTHN_CHALLENGE_TTL_MS,
    allowCredentials: signers.map((key) => ({
      id: key.credentialId,
      transports: key.transports as ('usb' | 'nfc' | 'ble' | 'internal' | 'hybrid')[],
    })),
  });
  const now = input.now ?? new Date();
  await input.db.webAuthnChallenge.create({
    data: {
      purpose: 'OWNER_APPROVAL',
      userId: input.userId,
      ownerActionType: input.action,
      targetCredentialRowId: isCredentialAction(input.action) ? targetId : null,
      ...(!isCredentialAction(input.action) ? { ownerActionTargetId: targetId } : {}),
      sessionBindingHash: input.sessionHash,
      bindingHash,
      challengeHash: digest(options.challenge),
      expiresAt: new Date(now.getTime() + WEBAUTHN_CHALLENGE_TTL_MS),
    },
  });
  return options;
}

export async function finishOwnerPasskeyActionApproval(input: {
  db: PrismaClient;
  userId: string;
  sessionHash: string;
  bindingSecret: string;
  response: AuthenticationResponseJSON;
  env?: Env;
  now?: Date;
}): Promise<{ approvalToken: string; expiresInSeconds: number }> {
  if (!input.userId || typeof input.response?.id !== 'string' || input.response.id.length > 512) {
    throw new AppError('FORBIDDEN');
  }
  const now = input.now ?? new Date();
  const bindingHash = validateBinding(input.sessionHash, input.bindingSecret);
  const challengeHash = signedChallenge(input.response);
  const challenge = await input.db.webAuthnChallenge.findUnique({ where: { challengeHash } });
  if (
    !challenge ||
    challenge.purpose !== 'OWNER_APPROVAL' ||
    challenge.userId !== input.userId ||
    !challenge.ownerActionType ||
    !SHA256.test(challenge.sessionBindingHash ?? '') ||
    challenge.sessionBindingHash !== input.sessionHash ||
    challenge.bindingHash !== bindingHash ||
    challenge.usedAt ||
    challenge.expiresAt <= now
  ) {
    throw new AppError('FORBIDDEN');
  }
  validateAction(challenge.ownerActionType);
  if (
    (isCredentialAction(challenge.ownerActionType) && challenge.ownerActionTargetId != null) ||
    (!isCredentialAction(challenge.ownerActionType) &&
      (challenge.targetCredentialRowId != null || !challenge.ownerActionTargetId))
  )
    throw new AppError('FORBIDDEN');
  const signer = await input.db.passkeyCredential.findUnique({
    where: { credentialId: input.response.id },
  });
  if (
    !signer ||
    signer.userId !== input.userId ||
    signer.revokedAt ||
    signer.signCount < 0 ||
    signer.signCount > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new AppError('FORBIDDEN');
  }
  const rp = readBillokWebAuthnRelyingParty(input.env ?? process.env);
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: (received) => digest(received) === challengeHash,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserVerification: true,
      credential: {
        id: signer.credentialId,
        publicKey: new Uint8Array(signer.publicKey),
        counter: Number(signer.signCount),
        transports: signer.transports,
      },
    });
  } catch {
    throw new AppError('FORBIDDEN');
  }
  if (
    !verification.verified ||
    !verification.authenticationInfo.userVerified ||
    verification.authenticationInfo.credentialID !== signer.credentialId
  ) {
    throw new AppError('FORBIDDEN');
  }
  const counter = verification.authenticationInfo.newCounter;
  if (
    !Number.isSafeInteger(counter) ||
    counter < 0 ||
    ((counter !== 0 || signer.signCount !== BigInt(0)) && BigInt(counter) <= signer.signCount)
  ) {
    throw new AppError('FORBIDDEN');
  }
  const approvalToken = randomBytes(32).toString('base64url');
  await input.db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', input.userId);
    const { user, keys } = await ownerStatus(tx, input.userId);
    const targetId = isCredentialAction(challenge.ownerActionType!)
      ? challenge.targetCredentialRowId
      : challenge.ownerActionTargetId;
    const signers = allowedSigners(keys, challenge.ownerActionType!, targetId ?? null);
    if (!signers.some((key) => key.id === signer.id)) throw new AppError('FORBIDDEN');
    const current = await tx.passkeyCredential.findUnique({ where: { id: signer.id } });
    if (
      !current ||
      current.revokedAt ||
      current.userId !== input.userId ||
      current.credentialId !== signer.credentialId ||
      current.signCount !== signer.signCount
    ) {
      throw new AppError('FORBIDDEN');
    }
    const consumed = await tx.webAuthnChallenge.updateMany({
      where: {
        id: challenge.id,
        userId: input.userId,
        purpose: 'OWNER_APPROVAL',
        challengeHash,
        bindingHash,
        sessionBindingHash: input.sessionHash,
        ownerActionType: challenge.ownerActionType,
        targetCredentialRowId: challenge.targetCredentialRowId,
        ...(!isCredentialAction(challenge.ownerActionType!)
          ? { ownerActionTargetId: challenge.ownerActionTargetId }
          : {}),
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) throw new AppError('FORBIDDEN');
    const updated = await tx.passkeyCredential.updateMany({
      where: { id: signer.id, userId: input.userId, revokedAt: null, signCount: signer.signCount },
      data: {
        signCount: BigInt(counter),
        lastUsedAt: now,
        deviceType: verification.authenticationInfo.credentialDeviceType,
        backedUp: verification.authenticationInfo.credentialBackedUp,
      },
    });
    if (updated.count !== 1) throw new AppError('FORBIDDEN');
    await tx.ownerPasskeyActionProof.create({
      data: {
        userId: input.userId,
        action: challenge.ownerActionType!,
        targetCredentialRowId: challenge.targetCredentialRowId,
        ...(!isCredentialAction(challenge.ownerActionType!)
          ? { ownerActionTargetId: challenge.ownerActionTargetId }
          : {}),
        signerCredentialRowId: signer.id,
        tokenHash: digest(approvalToken),
        sessionBindingHash: input.sessionHash,
        sessionSecurityVersion: user.sessionSecurityVersion,
        expiresAt: new Date(now.getTime() + OWNER_APPROVAL_TICKET_TTL_MS),
      },
    });
    // Only an ACTUALLY verified owner WebAuthn assertion is audited.
    // This entry is part of the same transaction as consuming the challenge;
    // a rollback must leave neither a usable proof nor a success record.
    await tx.adminAuditLog.create({
      data: {
        adminId: input.userId,
        action: 'OWNER_PASSKEY_APPROVAL_VERIFIED',
        metadata: {
          action: challenge.ownerActionType!,
          signerCredentialRowId: signer.id,
          ...(challenge.targetCredentialRowId ? { targetCredentialRowId: challenge.targetCredentialRowId } : {}),
          ...(challenge.ownerActionTargetId ? { ownerActionTargetId: challenge.ownerActionTargetId } : {}),
          expiresInSeconds: OWNER_APPROVAL_TICKET_TTL_MS / 1000,
        },
      },
    });
  });
  return { approvalToken, expiresInSeconds: OWNER_APPROVAL_TICKET_TTL_MS / 1000 };
}

/** CALL ONLY INSIDE THE SAME TRANSACTION AS THE OWNER MUTATION.
 * Caller must already lock the User row FOR UPDATE. The proof has no standalone
 * HTTP redemption endpoint: approving alone cannot change keys or log in.
 */
export async function consumeOwnerPasskeyActionProof(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    sessionHash: string;
    approvalToken: unknown;
    action: OwnerPasskeyAction;
    targetId?: string | null;
    now?: Date;
  },
): Promise<void> {
  validateAction(input.action);
  if (
    !input.userId ||
    !SHA256.test(input.sessionHash) ||
    typeof input.approvalToken !== 'string' ||
    !SECRET.test(input.approvalToken)
  ) {
    throw new AppError('FORBIDDEN');
  }
  const now = input.now ?? new Date();
  const proof = await tx.ownerPasskeyActionProof.findUnique({
    where: { tokenHash: digest(input.approvalToken) },
  });
  if (
    !proof ||
    proof.userId !== input.userId ||
    proof.action !== input.action ||
    (isCredentialAction(input.action)
      ? proof.targetCredentialRowId !== (input.targetId ?? null) || proof.ownerActionTargetId != null
      : proof.targetCredentialRowId != null || proof.ownerActionTargetId !== input.targetId) ||
    proof.sessionBindingHash !== input.sessionHash ||
    proof.consumedAt ||
    proof.expiresAt <= now
  ) {
    throw new AppError('FORBIDDEN');
  }
  const { user, keys } = await ownerStatus(tx, input.userId);
  if (
    user.sessionSecurityVersion !== proof.sessionSecurityVersion ||
    !keys.some((key) => key.id === proof.signerCredentialRowId)
  ) {
    throw new AppError('FORBIDDEN');
  }
  const allowed = allowedSigners(keys, input.action, input.targetId ?? null);
  if (!allowed.some((key) => key.id === proof.signerCredentialRowId)) throw new AppError('FORBIDDEN');
  const result = await tx.ownerPasskeyActionProof.updateMany({
    where: {
      id: proof.id,
      userId: input.userId,
      action: input.action,
      targetCredentialRowId: isCredentialAction(input.action) ? (input.targetId ?? null) : null,
      ...(!isCredentialAction(input.action) ? { ownerActionTargetId: input.targetId } : {}),
      tokenHash: digest(input.approvalToken),
      sessionBindingHash: input.sessionHash,
      sessionSecurityVersion: user.sessionSecurityVersion,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });
  if (result.count !== 1) throw new AppError('FORBIDDEN');
}
