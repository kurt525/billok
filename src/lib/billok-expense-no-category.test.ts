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

  test('new or updated categories are rejected server-side, historical values are untouched', () => {
    const router = read('src/server/trpc/routers/expenses.ts');
    expect(router.match(/category: z\.never\(\)\.optional\(\)/g)).toHaveLength(2);
    expect(router).not.toContain('input.category');
    expect(router).toContain('const { groupId, expenseId, shares, ...data } = input;');
    const schema = read('prisma/schema.prisma');
    expect(schema).toMatch(/\bcategory\s+String\?/);
  });
});
