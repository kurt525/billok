import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(
  resolve(process.cwd(), 'src/app/[locale]/(app)/groups/[groupId]/expenses/[expenseId]/edit/page.tsx'),
  'utf8',
);

describe('RUB-only edit expense form', () => {
  it('removes currency switching and foreign exchange while keeping the stored currency unchanged', () => {
    expect(page).not.toContain('COMMON_CURRENCIES');
    expect(page).not.toContain('id="currency"');
    expect(page).not.toContain('setCurrency');
    expect(page).not.toContain('setManualRate');
    expect(page).not.toContain('getExchangeRate');
    expect(page).not.toContain('exchangeRate: parsedManualRate');
    expect(page).not.toContain('currency: effectiveCurrency');
    expect(page).toContain('currency={expense.currency}');
    expect(page).toContain("isRubExpense ? '₽' : expense.currency");
  });

  it('allows RUB edits but refuses edits to historical foreign-currency expenses', () => {
    expect(page).toContain("expense.currency.toUpperCase() === 'RUB' && group.currency.toUpperCase() === 'RUB'");
    expect(page).toContain('if (!isRubExpense || !paidById');
    expect(page).toContain('disabled={!isRubExpense}');
    expect(page).toContain('disabled={!isRubExpense || updateExpense.isPending');
    expect(page).toContain('data-testid="rub-only-legacy-edit-warning"');
    expect(page).toContain("t('edit.rubOnlyLegacyExpense'");
    expect(page).toContain('amount: amountCents');
    expect(page).toContain('splitMode,');
  });
});
