import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  issueGuestPersonToken,
  revealGuestPersonToken,
  revealGuestPeopleTokens,
  revealGuestSplitResult,
  safeGuestPersonTokenEqual,
  sealGuestPersonToken,
  sealGuestPeopleTokens,
} from './guest-person-secret';

const ID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_B = 'aaaaaaaa-0000-4000-8000-000000000002';

describe('Issue #1 3.25.2.3: guest personal tokens sealed at rest', () => {
  beforeEach(() => vi.stubEnv('AUTH_SECRET', 'disposable-BillOK-test-key-for-guest-people-32bytes-minimum'));
  afterEach(() => vi.unstubAllEnvs());

  it('issues independent CSPRNG 256-bit personal bearer tokens, never UUID or shared token', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const token = issueGuestPersonToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      expect(tokens.has(token)).toBe(false);
      tokens.add(token);
    }
  });

  it('stores only AES-GCM ciphertext; a server read recovers exactly the bearer', () => {
    const token = issueGuestPersonToken();
    const sealed = sealGuestPersonToken(ID_A, token);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{95}$/);
    expect(sealed).not.toContain(token);
    expect(revealGuestPersonToken(ID_A, sealed)).toBe(token);
    expect(sealGuestPersonToken(ID_A, token)).not.toBe(sealed);
  });

  it('binds ciphertext to the correct personId and deployment secret', () => {
    const token = issueGuestPersonToken();
    const sealed = sealGuestPersonToken(ID_A, token);
    expect(() => revealGuestPersonToken(ID_B, sealed)).toThrow('недоступна');
    vi.stubEnv('AUTH_SECRET', 'different-disposable-BillOK-test-key-for-guest-people-32bytes');
    expect(() => revealGuestPersonToken(ID_A, sealed)).toThrow('недоступна');
  });

  it('rejects tampering, malformed, UUID and absent encryption keys', () => {
    const token = issueGuestPersonToken();
    const sealed = sealGuestPersonToken(ID_A, token);
    const bad = sealed.slice(0, 10) + (sealed[10] === 'A' ? 'B' : 'A') + sealed.slice(11);
    expect(() => revealGuestPersonToken(ID_A, bad)).toThrow('недоступна');
    expect(() => sealGuestPersonToken(ID_A, 'aaaaaaaa-0000-4000-8000-000000000001')).toThrow();
    expect(() => revealGuestPersonToken(ID_A, token)).toThrow('недоступна');
    vi.stubEnv('AUTH_SECRET', '');
    vi.stubEnv('NEXTAUTH_SECRET', '');
    expect(() => sealGuestPersonToken(ID_A, token)).toThrow('ключ');
  });

  it('preserves all nonsecret guest fields, and only the trusted server sees unsealed people', () => {
    const token = issueGuestPersonToken();
    const people = [
      { id: ID_A, name: 'Илья', personToken: token, tipCents: 50, join: { key: 'original' } },
      { id: ID_B, name: 'Гость 2', tipCents: 0 },
    ];
    const stored = sealGuestPeopleTokens(people);
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(token);
    expect(serialized).toContain('v1.');
    expect(revealGuestPeopleTokens(stored)).toEqual(people);
    expect(revealGuestSplitResult({ id: 'receipt', people: stored }).people).toEqual(people);
    expect(revealGuestSplitResult([{ id: 'receipt', people: stored }])[0]!.people).toEqual(people);
  });

  it('rejects noncanonical or previously used UUIDs before saving and fails closed on bad JSON', () => {
    for (const bad of [
      [{ id: ID_A, personToken: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Legacy' }],
      [{ id: ID_A, personToken: 'short', name: 'Short' }],
      [{ id: '', personToken: issueGuestPersonToken(), name: 'Unidentified' }],
    ]) {
      expect(() => sealGuestPeopleTokens(bad)).toThrow();
    }
    expect(() => revealGuestPeopleTokens([{ id: ID_A, personToken: issueGuestPersonToken() }])).toThrow();
  });

  it('uses a constant-time hash comparison without treating UUIDs or blanks as credentials', () => {
    const a = issueGuestPersonToken();
    const b = issueGuestPersonToken();
    expect(safeGuestPersonTokenEqual(a, a)).toBe(true);
    expect(safeGuestPersonTokenEqual(a, b)).toBe(false);
    expect(safeGuestPersonTokenEqual(a, '')).toBe(false);
    expect(
      safeGuestPersonTokenEqual('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),
    ).toBe(false);
  });

  it('encrypts all actual Prisma GuestSplit create/update/transaction paths', () => {
    const code = readFileSync('src/server/db.ts', 'utf8');
    expect(code).toContain('guestSplit:');
    expect(code).toContain("operation === 'create'");
    expect(code).toContain("operation === 'update'");
    expect(code).toContain('data.people = sealGuestPeopleTokens(data.people)');
    expect(code).toContain('revealGuestSplitResult(await query(args))');
    const router = readFileSync('src/server/trpc/routers/guest.ts', 'utf8');
    expect(router).not.toContain('personToken: z.string().uuid()');
    expect(router).not.toContain('personToken: randomUUID()');
    const guard = readFileSync('prisma/after-push/guest_person_link_storage_guard.sql', 'utf8');
    expect(guard).toContain('guest_person_link_storage_format');
  });
});
