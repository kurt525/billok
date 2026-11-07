import { describe, expect, it } from 'vitest';
import {
  becameVerified,
  mergeGuestPaymentStatuses,
  newlyDeclaredGuestPayments,
  type GuestPaymentNoticeRow,
} from './guest-payment-notifications';

const a: GuestPaymentNoticeRow = { personId: 'anna', declaredPaidAt: null, verifiedAt: null };
const b: GuestPaymentNoticeRow = { personId: 'victor', declaredPaidAt: null, verifiedAt: null };
const marked: GuestPaymentNoticeRow = { ...a, declaredPaidAt: '2026-10-29T03:00:00.000Z' };
const verified: GuestPaymentNoticeRow = { ...marked, verifiedAt: '2026-10-29T03:02:00.000Z' };

describe('guest receipt notification transitions', () => {
  it('does not notify for declarations already present when page loads', () => {
    expect(newlyDeclaredGuestPayments(null, [marked, b])).toEqual([]);
  });
  it('notifies the payer only on a newly declared payment for a known participant', () => {
    expect(newlyDeclaredGuestPayments([a, b], [marked, b])).toEqual([marked]);
    expect(newlyDeclaredGuestPayments([marked, b], [marked, b])).toEqual([]);
  });
  it('ignores newly introduced identities, reordered rows and unrelated verification', () => {
    expect(newlyDeclaredGuestPayments([b], [marked, b])).toEqual([]);
    expect(newlyDeclaredGuestPayments([marked, b], [b, verified])).toEqual([]);
  });
  it('keeps confirmed statuses when an older poll completes late', () => {
    expect(mergeGuestPaymentStatuses([verified, b], [a, b])[0]).toEqual(verified);
  });
  it('only notifies a debtor of a new verification after an initial read', () => {
    expect(becameVerified(undefined, verified.verifiedAt)).toBe(false);
    expect(becameVerified(null, verified.verifiedAt)).toBe(true);
    expect(becameVerified(verified.verifiedAt, verified.verifiedAt)).toBe(false);
    expect(becameVerified(null, null)).toBe(false);
  });
});
