import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const createPath = 'src/app/[locale]/(app)/groups/[groupId]/expenses/new/page.tsx';
const editPath = 'src/app/[locale]/(app)/groups/[groupId]/expenses/[expenseId]/edit/page.tsx';
const detailPath = 'src/app/[locale]/(app)/groups/[groupId]/expenses/[expenseId]/page.tsx';

describe('BillOK manual group expenses do not use the inherited ShareTab category', () => {
  test('create and edit forms have no category control, state, tooltip or request field', () => {
    for (const path of [createPath, editPath]) {
      const source = read(path);
      expect(source, path).not.toContain('id="category"');
      expect(source, path).not.toContain('setCategory');
      expect(source, path).not.toContain('categoryPlaceholder');
      expect(source, path).not.toContain('category: category');
      expect(source, path).toContain('id="amount"');
      expect(source, path).toContain('id="paidBy"');
    }
  });

  test('expense details do not display an inherited category as a charge', () => {
    const detail = read(detailPath);
    expect(detail).not.toContain("t('detail.category')");
    expect(detail).not.toContain('{e.category}');
    expect(detail).toContain('expense-detail-payer');
  });

  test('server rejects category writes and generated schema drops the column', () => {
    const router = read('src/server/trpc/routers/expenses.ts');
    expect(router.match(/category: z\.never\(\)\.optional\(\)/g)).toHaveLength(2);
    expect(router).not.toContain('input.category');
    expect(router).toContain('const { groupId, expenseId, shares, ...data } = input;');
    expect(read('prisma/schema.prisma')).not.toMatch(/\bcategory\s+String\?/);
    expect(read('prisma/seed.ts')).not.toContain('category:');
    expect(read('src/app/[locale]/(app)/groups/[groupId]/page.tsx')).not.toContain('expense.category');
  });

  test('existing test databases discard only the obsolete category column', () => {
    const migration = read('prisma/migrations/expense_category_drop.sql');
    expect(migration).toContain('ALTER TABLE IF EXISTS "Expense" DROP COLUMN IF EXISTS "category";');
    expect(migration).not.toMatch(/DROP\s+TABLE/i);
    expect(read('scripts/dev.mjs')).toContain('prisma/migrations/expense_category_drop.sql');
  });
});
