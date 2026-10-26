import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const receiptViews = ['src/components/receipts/item-assignment.tsx', 'src/app/[locale]/split/page.tsx'];

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Mobile receipt item forms, guest and group', () => {
  for (const path of receiptViews) {
    it(path + ': stacks item inputs at phone width and keeps save/cancel reachable', () => {
      const source = read(path);
      expect(source).toContain('grid min-w-0 grid-cols-2 gap-2');
      expect(source).toContain('inputMode="numeric"');
      expect(source).toContain('inputMode="decimal"');
      expect(source).toContain('min-h-11');
      expect(source).toContain('parseReceiptQuantity(newItem.quantity)');
      expect(source).toContain('parseReceiptQuantity(editValues.quantity)');
      expect(source).not.toContain('parseInt(newItem.quantity) || 1');
      expect(source).not.toContain('parseInt(editValues.quantity)');
    });

    it(path + ': has touch-size item actions, participant chips and split controls', () => {
      const source = read(path);
      expect(source).toContain('flex size-11 shrink-0 items-center justify-center rounded-lg');
      expect(source).toContain('min-h-11 max-w-full items-center');
      expect(source).toContain('className="min-h-11"');
      expect(source).toContain('h-11 w-20 text-base');
      expect(source).toContain('flex flex-wrap items-center gap-2');
      expect(source).toContain('min-w-0 break-words font-medium');
    });
  }
});

describe('Phone input and minimum touch targets for all group expense modes', () => {
  it('percentage and share fields use Russian-friendly keyboards and touch-size inputs', () => {
    const pct = read('src/components/expenses/percentage-split.tsx');
    expect(pct).toContain('parseRussianPercentage');
    expect(pct).toContain('inputMode="decimal"');
    expect(pct).toContain('h-11 w-24');
    expect(pct).not.toContain('parseFloat(percentages[');

    const shares = read('src/components/expenses/shares-split.tsx');
    expect(shares).toContain('inputMode="numeric"');
    expect(shares).toContain('h-11 w-20');
  });

  it('currency and payer selectors are at least 44px tall on create and edit forms', () => {
    for (const file of [
      'src/app/[locale]/(app)/groups/[groupId]/expenses/new/page.tsx',
      'src/app/[locale]/(app)/groups/[groupId]/expenses/[expenseId]/edit/page.tsx',
    ]) {
      const ui = read(file);
      expect(ui).not.toContain('flex h-9 w-full rounded-md border');
      expect(ui).toContain('flex h-11 min-w-0 w-full rounded-md border');
      expect(ui).toContain('inputMode="decimal"');
    }
  });
});

describe('Expense split modes at narrow Android widths', () => {
  it('keeps all four participant rows and their amount fields in the mobile column', () => {
    for (const component of ['equal-split', 'exact-split', 'percentage-split', 'shares-split']) {
      const ui = read('src/components/expenses/' + component + '.tsx');
      expect(ui, component).toContain('data-testid="split-member-row"');
      expect(ui, component).toContain('min-w-0');
      expect(ui, component).toContain('break-words');
    }
    for (const component of ['exact-split', 'percentage-split', 'shares-split']) {
      const ui = read('src/components/expenses/' + component + '.tsx');
      expect(ui, component).toContain('flex-col gap-2 rounded-md border p-3 sm:flex-row');
    }
  });

  it('makes split mode selectors and save actions touch-size', () => {
    for (const path of [
      'src/app/[locale]/(app)/groups/[groupId]/expenses/new/page.tsx',
      'src/app/[locale]/(app)/groups/[groupId]/expenses/[expenseId]/edit/page.tsx',
    ]) {
      const ui = read(path);
      expect(ui).toContain('expense-split-mode-');
      expect(ui).toContain('min-h-11 min-w-0 rounded-md border');
      expect(ui).toContain('className="min-h-11 w-full text-base"');
    }
  });
});
