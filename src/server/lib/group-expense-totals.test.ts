import { describe, expect, it } from 'vitest';
import { totalsInGroupCurrency, type ExpenseCurrencyAggregate } from './group-expense-totals';

const aggregate = (groupId: string, currency: string, amount: number | null): ExpenseCurrencyAggregate => ({
  groupId,
  currency,
  _sum: { amount },
});

describe('admin group totals without legacy FX conversion', () => {
  it('sums exact RUB kopecks and keeps totals in their stored group currency', () => {
    const totals = totalsInGroupCurrency(
      [
        { id: 'rub', currency: 'RUB' },
        { id: 'usd', currency: 'USD' },
        { id: 'empty', currency: 'RUB' },
      ],
      [aggregate('rub', 'RUB', 10001), aggregate('rub', 'RUB', 1), aggregate('usd', 'USD', 999)],
    );
    expect(totals.get('rub')).toBe(10002);
    expect(totals.get('usd')).toBe(999);
    expect(totals.get('empty')).toBe(0);
  });

  it('never adds an old foreign expense to a RUB total, even when a previous FX conversion existed', () => {
    const groups = [{ id: 'rub', currency: 'RUB' }];
    expect(totalsInGroupCurrency(groups, [aggregate('rub', 'EUR', 500)]).get('rub')).toBeNull();
    expect(
      totalsInGroupCurrency(groups, [aggregate('rub', 'RUB', 100), aggregate('rub', 'EUR', 500)]).get('rub'),
    ).toBeNull();
    expect(
      totalsInGroupCurrency(groups, [aggregate('rub', 'EUR', 500), aggregate('rub', 'RUB', 100)]).get('rub'),
    ).toBeNull();
  });

  it('ignores unrelated groups without corrupting an existing RUB total', () => {
    const result = totalsInGroupCurrency(
      [{ id: 'one', currency: 'RUB' }],
      [aggregate('other', 'RUB', 99999), aggregate('one', 'RUB', 1), aggregate('one', 'RUB', 2)],
    );
    expect(result.get('one')).toBe(3);
    expect(result.has('other')).toBe(false);
  });

  it('returns zero for an empty group or empty aggregation', () => {
    expect(totalsInGroupCurrency([{ id: 'empty', currency: 'RUB' }], []).get('empty')).toBe(0);
    expect(totalsInGroupCurrency([{ id: 'empty', currency: 'RUB' }], [aggregate('empty', 'RUB', null)]).get('empty')).toBe(0);
  });
});
