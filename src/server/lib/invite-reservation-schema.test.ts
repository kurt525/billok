import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('SystemInvite reservation schema', () => {
  const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  const invite = schema.match(/model SystemInvite \{([\s\S]*?)\n\}/)?.[1];

  it('keeps reservation distinct from consumed and revoked invitations', () => {
    expect(invite).toBeDefined();
    expect(invite).toMatch(/reservedById\s+String\?/);
    expect(invite).toMatch(/reservedUntil\s+DateTime\?/);
    expect(invite).toMatch(/usedById\s+String\?/);
    expect(invite).toMatch(/usedAt\s+DateTime\?/);
    expect(invite).toMatch(/expiresAt\s+DateTime\?/);
    expect(invite).toMatch(/revokedAt\s+DateTime\?/);
    expect(invite).toMatch(/code\s+String\s+@unique/);
  });

  it('links reservations to users and indexes expiry for later cleanup', () => {
    expect(invite).toContain('@relation("SystemInviteReservedBy"');
    expect(invite).toContain('fields: [reservedById], references: [id], onDelete: SetNull');
    expect(invite).toContain('@@index([reservedUntil])');
    expect(invite).toContain('@@index([reservedById])');
    expect(schema).toMatch(/systemInvitesReserved\s+SystemInvite\[\]\s+@relation\("SystemInviteReservedBy"\)/);
    expect(invite).toContain('@relation("SystemInviteUsedBy"');
  });
});
