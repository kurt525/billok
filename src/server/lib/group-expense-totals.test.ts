import { describe, expect, it } from 'vitest';
import { totalsInGroupCurrency, type ExpenseCurrencyAggregate } from './group-expense-totals';

const aggregate = (
  groupId: string,
  currency: string,
  amount: number,
  converted: number | null,
  convertedCount: number,
  count = 1,
): ExpenseCurrencyAggregate => ({
  groupId,
  currency,
  _sum: { amount, baseCurrencyAmount: converted },
  _count: { id: count, baseCurrencyAmount: convertedCount },
});

describe('admin group totals in the group currency', () => {
  it('keeps kopecks and never labels old EUR/USD amounts as RUB', () => {
    const totals = totalsInGroupCurrency(
      [
        { id: 'rub', currency: 'RUB' },
        { id: 'usd', currency: 'USD' },
        { id: 'empty', currency: 'RUB' },
      ],
      [
        aggregate('rub', 'RUB', 10001, null, 0),
        aggregate('rub', 'EUR', 1000, 10725, 1),
        aggregate('usd', 'USD', 999, null, 0),
      ],
    );
    expect(totals.get('rub')).toBe(20726);
    expect(totals.get('usd')).toBe(999);
    expect(totals.get('empty')).toBe(0);
  });

  it('does not pretend an unconverted foreign expense is zero or use the wrong currency', () => {
    const groups = [{ id: 'rub', currency: 'RUB' }];
    expect(totalsInGroupCurrency(groups, [aggregate('rub', 'EUR', 500, null, 0)]).get('rub')).toBeNull();
    // Even when some EUR expenses are converted, a missing conversion invalidates the sum.
    expect(totalsInGroupCurrency(groups, [aggregate('rub', 'EUR', 700, 35000, 1, 2)]).get('rub')).toBeNull();
    expect(
      totalsInGroupCurrency(groups, [aggregate('rub', 'RUB', 100, null, 0), aggregate('rub', 'EUR', 500, null, 0)]).get(
        'rub',
      ),
    ).toBeNull();
  });

  it('ignores unrelated groups and adds only converted integer kopecks', () => {
    const result = totalsInGroupCurrency(
      [{ id: 'one', currency: 'RUB' }],
      [
        aggregate('other', 'RUB', 99999, null, 0),
        aggregate('one', 'RUB', 1, null, 0),
        aggregate('one', 'USD', 50, 333, 1),
      ],
    );
    expect(result.get('one')).toBe(334);
    expect(result.has('other')).toBe(false);
  });
});
