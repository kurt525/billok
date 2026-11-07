import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('one-time registration email confirmation storage', () => {
  const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  const model = schema.match(/model EmailVerificationRequest \{([\s\S]*?)\n\}/)?.[1];

  it('stores only the SHA-256 digest, expiry and redemption time for a specific user', () => {
    expect(model).toBeDefined();
    expect(model).toMatch(/tokenHash\s+String\s+@unique\s+@db\.VarChar\(64\)/);
    expect(model).toMatch(/userId\s+String\b/);
    expect(model).toMatch(/expiresAt\s+DateTime\b/);
    expect(model).toMatch(/consumedAt\s+DateTime\?/);
    expect(model).not.toMatch(/\brawToken\b|\bsecret\s+String\b/);
  });

  it('links to the user with cascading cleanup and indexes expired requests', () => {
    expect(model).toContain('onDelete: Cascade');
    expect(model).toContain('@@index([userId, expiresAt])');
    expect(model).toContain('@@index([expiresAt])');
    expect(schema).toMatch(/emailVerificationRequests\s+EmailVerificationRequest\[\]/);
    expect(schema).toMatch(/model VerificationToken \{/);
  });
});
