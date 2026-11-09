import { describe, expect, it } from 'vitest';
import { groupGuestPayerPayments } from './guest-payer-payment-groups';

const payer = { personId: 'payer', name: 'Борис', amount: 742, declaredPaidAt: null, verifiedAt: null };
const anna = { personId: 'anna', name: 'Анна', amount: 459, declaredPaidAt: null, verifiedAt: null };
const victor = { personId: 'victor', name: 'Виктор', amount: 408, declaredPaidAt: null, verifiedAt: null };
const family = {
  personId: 'wife',
  name: 'Семья',
  amount: 951,
  memberIds: ['wife', 'husband', 'child'],
  declaredPaidAt: '2026-11-09T15:00:00.000Z',
  verifiedAt: null,
};
const verified = { ...family, verifiedAt: '2026-11-09T15:01:00.000Z' };

describe('Issue #1 5.6: payer payment status groups', () => {
  it('starts with unpaid debts and never includes the payer own share', () => {
    const groups = groupGuestPayerPayments([payer, anna, victor], payer.personId);
    expect(groups.unpaid).toEqual([anna, victor]);
    expect(groups.awaiting).toEqual([]);
    expect(groups.verified).toEqual([]);
  });

  it('moves a declaration through awaiting and verified without changing cents or duplicating debt', () => {
    const markedAnna = { ...anna, declaredPaidAt: '2026-11-09T15:00:00.000Z' };
    const waiting = groupGuestPayerPayments([payer, markedAnna, victor], payer.personId);
    expect(waiting.awaiting).toEqual([markedAnna]);
    expect(waiting.unpaid).toEqual([victor]);
    const confirmed = groupGuestPayerPayments(
      [payer, { ...markedAnna, verifiedAt: '2026-11-09T15:01:00.000Z' }, victor],
      payer.personId,
    );
    expect(confirmed.verified).toEqual([{ ...markedAnna, verifiedAt: '2026-11-09T15:01:00.000Z' }]);
    expect(confirmed.awaiting).toEqual([]);
    expect(confirmed.unpaid).toEqual([victor]);
  });

  it('a cancelled declaration returns to unpaid; a stray verification without a declaration is not accepted', () => {
    expect(groupGuestPayerPayments([anna], payer.personId).unpaid).toEqual([anna]);
    const anomalous = { ...anna, verifiedAt: '2026-11-09T15:00:00.000Z' };
    expect(groupGuestPayerPayments([anomalous], payer.personId).unpaid).toEqual([anomalous]);
  });

  it('counts a family payment exactly once with one original precise group amount', () => {
    const awaiting = groupGuestPayerPayments([payer, family, victor], payer.personId);
    expect(awaiting.awaiting).toHaveLength(1);
    expect(awaiting.awaiting[0]).toEqual(family);
    expect(awaiting.awaiting[0]!.amount).toBe(951);
    const confirmed = groupGuestPayerPayments([payer, verified, victor], payer.personId);
    expect(confirmed.verified).toEqual([verified]);
    expect(confirmed.unpaid).toEqual([victor]);
  });

  it('shows all three empty groups when no one owes the payer', () => {
    expect(groupGuestPayerPayments([payer], payer.personId)).toEqual({
      verified: [],
      awaiting: [],
      unpaid: [],
    });
  });
});
