import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';

/** Real ES256 signatures (not mocked): the WebAuthn verifier must reject
 * forged origins, missing user verification and modified signatures. */
const challenge = 'x'.repeat(43);
const rpId = 'billok.ru';
const origin = 'https://billok.ru';
const credentialId = Buffer.from('billok-e2e-credential').toString('base64url');

function signedAssertion(options?: { origin?: string; uv?: boolean; wrongSignature?: boolean }) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  if (!jwk.x || !jwk.y) throw new Error('P-256 key missing coordinates');
  const publicKeyCose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')],
    ]),
  );
  const clientData = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      challenge,
      origin: options?.origin ?? origin,
      crossOrigin: false,
    }),
  );
  const authenticatorData = Buffer.alloc(37);
  createHash('sha256').update(rpId).digest().copy(authenticatorData, 0);
  authenticatorData[32] = options?.uv === false ? 0x01 : 0x05;
  authenticatorData.writeUInt32BE(4, 33);
  const message = Buffer.concat([authenticatorData, createHash('sha256').update(clientData).digest()]);
  const signature = sign('sha256', message, privateKey);
  if (options?.wrongSignature) signature[signature.length - 1] = (signature[signature.length - 1] ?? 0) ^ 1;
  const response: AuthenticationResponseJSON = {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
    response: {
      authenticatorData: authenticatorData.toString('base64url'),
      clientDataJSON: clientData.toString('base64url'),
      signature: signature.toString('base64url'),
    },
  };
  return { response, publicKeyCose };
}
const verify = async (obj: ReturnType<typeof signedAssertion>) =>
  verifyAuthenticationResponse({
    response: obj.response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    requireUserVerification: true,
    credential: {
      id: credentialId,
      publicKey: obj.publicKeyCose,
      counter: 3,
      transports: ['internal'],
    },
  });

describe('Issue #1 6.3.2.2 real cryptographic WebAuthn assertions', () => {
  it('accepts a valid ES256 assertion only with correct challenge, origin and UV', async () => {
    const result = await verify(signedAssertion());
    expect(result.verified).toBe(true);
    expect(result.authenticationInfo).toMatchObject({
      credentialID: credentialId,
      newCounter: 4,
      userVerified: true,
      origin,
      rpID: rpId,
    });
  });
  it('rejects a properly signed response from another origin', async () => {
    await expect(verify(signedAssertion({ origin: 'https://other.ru' }))).rejects.toThrow();
  });
  it('rejects authentication without biometric/PIN user verification', async () => {
    await expect(verify(signedAssertion({ uv: false }))).rejects.toThrow();
  });
  it('rejects a modified authenticator signature', async () => {
    const result = await verify(signedAssertion({ wrongSignature: true }));
    expect(result.verified).toBe(false);
  });
});
