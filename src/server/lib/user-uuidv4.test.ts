import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Issue #1 6.13.1: stable crypto-random User.id only', () => {
  const schema = readFileSync('prisma/schema.prisma', 'utf8');

  it('generates User.id with Prisma UUIDv4 instead of cuid, timestamp or sequence', () => {
    expect(schema).toMatch(/model User\s*\{[\s\S]*?\bid\s+String\s+@id @default\(uuid\(\)\)/u);
    const block = schema.split('model User {')[1]?.split('\n}')[0] ?? '';
    expect(block).not.toMatch(/@default\((?:cuid|autoincrement|ulid)\(/u);
  });

  it('does not change the ID format of Group, Guest or other sections', () => {
    expect(schema).toMatch(/model Group\s*\{\s*id\s+String\s+@id @default\(cuid\(\)\)/u);
    expect(schema).toMatch(/model OwnerBootstrap\s*\{[\s\S]*?userId\s+String\s+@unique/u);
    expect(schema).toMatch(/user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Restrict\)/u);
  });

  it('requires real Prisma/PostgreSQL UUIDv4 generation and rollback before QA seed', () => {
    const workflow = readFileSync('.github/workflows/billok-ci.yml', 'utf8');
    const integration = readFileSync('scripts/qa-user-uuidv4-postgres.ts', 'utf8');
    expect(workflow).toContain('BILLOK_USER_UUIDV4_POSTGRES=PASS');
    expect(workflow).toContain('scripts/qa-user-uuidv4-postgres.ts');
    expect(integration).toContain('BILLOK_QA_DISPOSABLE_DB');
    expect(integration).toContain('await db.$transaction(');
    expect(integration).toContain('assert.match(user.id, UUID_V4');
  });
});
