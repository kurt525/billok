import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Issue #1 6.13.3: bearer-link guest responses do not disclose User.id', () => {
  it('serializes guest people through public-only projection, never account binding', () => {
    const code = readFileSync('src/server/trpc/routers/guest.ts', 'utf8');
    const projection = code.slice(code.indexOf('function toPublicPerson('), code.indexOf('function toPublicPeople('));
    expect(projection).toContain('hasJoined');
    expect(projection).toContain('isRegistered');
    expect(projection).not.toMatch(/return\s*\{[^}]*accountUserId\s*:/u);
    expect(code).toContain('people: toPublicPeople(split.people as GuestSessionPerson[])');
    expect(code).toContain('...toPublicPerson(person)');
  });

  it('requires platform-owner-only API for full registered account list and totalCount', () => {
    const code = readFileSync('src/server/trpc/routers/admin.ts', 'utf8');
    expect(code).toMatch(/ownerRegisteredUsers:\s*ownerUsersProcedure/u);
    expect(code).toMatch(/listUsers:\s*adminProcedure/u);
    expect(code).toContain('await requireOwner(ctx.db, ctx.user.id)');
    const ownerCode = readFileSync('src/server/lib/owner-user-admin.ts', 'utf8');
    expect(ownerCode).toContain('const where: Prisma.UserWhereInput = { isPlaceholder: false }');
    expect(ownerCode).toContain('encodeOwnerUserCursor(');
  });
});
