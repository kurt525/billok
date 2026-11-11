import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('isolated one-time password reset request storage', () => {
  const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  const model = schema.match(/model PasswordResetRequest \{([\s\S]*?)\n\}/)?.[1];

  it('stores only the SHA-256 digest, account, expiry and consumption time', () => {
    expect(model).toBeDefined();
    expect(model).toMatch(/tokenHash\s+String\s+@unique\s+@db\.VarChar\(64\)/);
    expect(model).toMatch(/userId\s+String\b/);
    expect(model).toMatch(/expiresAt\s+DateTime\b/);
    expect(model).toMatch(/consumedAt\s+DateTime\?/);
    expect(model).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\)/);
    expect(model).not.toMatch(/\brawToken\b|\bpassword\s+String\b|\bsecret\s+String\b/i);
  });

  it('cascades on user deletion and isolates password reset tokens', () => {
    expect(model).toContain('onDelete: Cascade');
    expect(model).toContain('@@index([userId, expiresAt])');
    expect(model).toContain('@@index([expiresAt])');
    expect(schema).toMatch(/passwordResetRequests\s+PasswordResetRequest\[\]/);
    expect(schema).toMatch(/model EmailVerificationRequest \{/);
    // Auth.js Magic Link storage is removed; this is a dedicated confirmation flow.
    expect(schema).not.toMatch(/model VerificationToken \{/);
    expect(model).not.toMatch(/\bidentifier\s+String\b/);
  });
});
