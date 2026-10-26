import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'src/app/[locale]/(app)/groups/[groupId]/expenses/new/page.tsx'),
  'utf8',
);

describe('RUB-only creation of new group expenses', () => {
  it('sends RUB and never exposes other currencies or exchange rates', () => {
    expect(source).toContain("currency: 'RUB'");
    expect(source).toContain('currency="RUB"');
    expect(source).toContain("{t('new.amount')} (₽)");
    expect(source).not.toContain('COMMON_CURRENCIES');
    expect(source).not.toContain('id="currency"');
    expect(source).not.toContain('effectiveCurrency');
    expect(source).not.toContain('exchangeRate:');
    expect(source).not.toContain('getExchangeRate');
    expect(source).not.toContain('manualRate');
  });

  it('prevents changing balances of historical non-RUB groups via new expense and receipt forms', () => {
    expect(source).toContain("group.data?.currency?.toUpperCase() === 'RUB'");
    expect(source).toContain("t('new.rubOnlyLegacyGroup', { currency: groupCurrency })");
    expect(source).toContain('disabled={createManualReceipt.isPending || !isRubGroup}');
    expect(source).toContain('if (!isRubGroup || !effectivePaidById');
    expect(source).toContain('disabled={!isRubGroup || createExpense.isPending');
  });
});
