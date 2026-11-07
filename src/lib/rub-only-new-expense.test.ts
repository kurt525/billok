import { existsSync, readFileSync } from 'node:fs';
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

  it('does not ship a currency-rate API client for RUB-only BillOK', () => {
    expect(existsSync(resolve(process.cwd(), 'src/server/lib/exchange-rates.ts'))).toBe(false);
  });

  it('seeds only RUB groups and uses the existing seed group for manual receipt QA', () => {
    const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
    const seed = read('prisma/seed.ts');
    const fixture = read('e2e/seed-mobile-receipt.ts');
    const mobile = read('e2e/billok-mobile-receipt-actions.spec.ts');
    const workflow = read('.github/workflows/billok-ci.yml');
    expect(seed.match(/currency: 'RUB'/g)).toHaveLength(3);
    expect(seed).not.toContain("currency: 'USD'");
    expect(fixture).toContain("group.currency !== 'RUB'");
    expect(fixture).not.toContain('db.group.create(');
    expect(mobile).not.toContain('BILLOK_MOBILE_RUB_GROUP_ID');
    expect(workflow).not.toContain('BILLOK_MOBILE_RUB_GROUP_ID');
  });

  it('prevents changing balances of historical non-RUB groups via new expense and receipt forms', () => {
    expect(source).toContain("group.data?.currency?.toUpperCase() === 'RUB'");
    expect(source).toContain("t('new.rubOnlyLegacyGroup', { currency: groupCurrency })");
    expect(source).toContain('data-testid="rub-only-legacy-warning"');
    expect(source).toContain('disabled={createManualReceipt.isPending || !isRubGroup}');
    expect(source).toContain('if (!isRubGroup || !effectivePaidById');
    expect(source).toContain('disabled={!isRubGroup || createExpense.isPending');
  });
});
