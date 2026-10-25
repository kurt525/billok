import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractedDataSchema } from '@/server/lib/json-schemas';
import { formatCents, isValidMoneyInput, parseToCents } from '@/lib/money';

const read = (filename: string) => readFileSync(resolve(process.cwd(), filename), 'utf8');

describe('BillOK RUB and ru-RU defaults', () => {
  it('defaults manual receipts to rubles without changing an explicitly stored currency', () => {
    const base = { subtotal: 123456, tax: 0, tip: 0, total: 123456 };
    expect(extractedDataSchema.parse(base).currency).toBe('RUB');
    expect(extractedDataSchema.parse({ ...base, currency: 'EUR' }).currency).toBe('EUR');
  });

  it('formats Russian money and rounds fractional kopecks without floating point', () => {
    const normalize = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');
    expect(formatCents(parseToCents('1 234,56'))).toBeDefined();
    expect(normalize(formatCents(parseToCents('1 234,56')))).toBe('1 234,56 ₽');
    expect(isValidMoneyInput('1 234,56')).toBe(true);
    expect(parseToCents('1,005')).toBe(101);
    expect(parseToCents('-0,005')).toBe(-1);
    expect(formatCents(100, 'EUR', 'ru')).toContain('€');
  });

  it('keeps server, UI and Prisma creation defaults in sync', () => {
    for (const filename of [
      'src/server/trpc/routers/groups.ts',
      'src/server/trpc/routers/expenses.ts',
      'src/server/trpc/routers/settlements.ts',
      'src/server/trpc/routers/guest.ts',
      'src/server/lib/json-schemas.ts',
    ]) {
      const source = read(filename);
      expect(source, filename).not.toContain(".default('USD')");
      expect(source, filename).not.toContain("?? 'USD'");
      expect(source, filename).toContain("'RUB'");
    }

    for (const filename of [
      'src/app/[locale]/(app)/dashboard/page.tsx',
      'src/app/[locale]/(app)/groups/[groupId]/expenses/new/page.tsx',
      'src/app/[locale]/(app)/groups/[groupId]/expenses/[expenseId]/page.tsx',
    ]) {
      expect(read(filename), filename).not.toContain("?? 'USD'");
    }

    const admin = read('src/components/admin/group-overview-section.tsx');
    expect(admin).toContain('formatCents(group.totalAmount, group.currency, locale)');
    expect(admin).not.toContain("formatCents(group.totalAmount, 'USD', locale)");

    const schema = read('prisma/schema.prisma');
    expect(schema).not.toContain('@default("USD")');
    expect((schema.match(/@default\("RUB"\)/g) ?? []).length).toBe(4);
    expect(schema).toMatch(/defaultCurrency\s+String\s+@default\("RUB"\)/);
    expect(schema).toMatch(/locale\s+String\s+@default\("ru"\)/);
  });
});
