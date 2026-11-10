import { describe, expect, it } from 'vitest';
import {
  becameVerified,
  mergeGuestPaymentStatuses,
  newlyDeclaredGuestPayments,
  newlyRevokedGuestPayments,
  shouldNotifyGuestReceiptConfirmation,
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
  it('preserves the exact server-calculated amount and participant identity for a new notification', () => {
    const previous = [{ ...a, name: 'Анна', amount: 459 }];
    const incoming = [{ ...marked, name: 'Анна', amount: 459 }];
    expect(newlyDeclaredGuestPayments(previous, incoming)).toEqual(incoming);
    expect(newlyDeclaredGuestPayments(incoming, incoming)).toEqual([]);
  });
  it('ignores newly introduced identities, reordered rows and unrelated verification', () => {
    expect(newlyDeclaredGuestPayments([b], [marked, b])).toEqual([]);
    expect(newlyDeclaredGuestPayments([marked, b], [b, verified])).toEqual([]);
  });
  it('5.18: payer sees one distinct revocation per server event, not one per SSE poll or reload', () => {
    const cancelled = { ...a, unmarkedAt: '2026-11-10T10:00:00.000Z' };
    const remark = { ...marked, unmarkedAt: cancelled.unmarkedAt };
    const cancelledAgain = { ...a, unmarkedAt: '2026-11-10T10:01:00.000Z' };
    expect(newlyRevokedGuestPayments(null, [cancelled, b])).toEqual([]);
    expect(newlyRevokedGuestPayments([marked, b], [cancelled, b])).toEqual([cancelled]);
    expect(newlyRevokedGuestPayments([cancelled, b], [cancelled, b])).toEqual([]);
    expect(newlyRevokedGuestPayments([cancelled, b], [remark, b])).toEqual([]);
    expect(newlyRevokedGuestPayments([remark, b], [cancelledAgain, b])).toEqual([cancelledAgain]);
    expect(newlyRevokedGuestPayments([b], [cancelled, b])).toEqual([]);
    // A fast mark/unmark/mark sequence still exposes the durable last
    // cancellation timestamp even if the client did not see the intermediate
    // declaration state on its 1.5s SSE ticks.
    expect(newlyRevokedGuestPayments([marked, b], [remark, b])).toEqual([remark]);
  });

  it('accepts an authoritative cancellation or revoked verification after stale reads are filtered by the caller', () => {
    expect(mergeGuestPaymentStatuses([marked, b], [a, b])[0]).toEqual(a);
    expect(mergeGuestPaymentStatuses([verified, b], [marked, b])[0]).toEqual(marked);
  });
  it('only notifies a debtor of a new verification after an initial read', () => {
    expect(becameVerified(undefined, verified.verifiedAt)).toBe(false);
    expect(becameVerified(null, verified.verifiedAt)).toBe(true);
    expect(becameVerified(verified.verifiedAt, verified.verifiedAt)).toBe(false);
    expect(becameVerified(null, null)).toBe(false);
  });
  it('sends a personal confirmation notice only to the actual sender, not family spectators', () => {
    expect(shouldNotifyGuestReceiptConfirmation(null, verified.verifiedAt, true)).toBe(true);
    expect(shouldNotifyGuestReceiptConfirmation(null, verified.verifiedAt, false)).toBe(false);
    expect(shouldNotifyGuestReceiptConfirmation(undefined, verified.verifiedAt, true)).toBe(false);
    expect(shouldNotifyGuestReceiptConfirmation(verified.verifiedAt, verified.verifiedAt, true)).toBe(false);
    expect(shouldNotifyGuestReceiptConfirmation(null, null, true)).toBe(false);
  });
});
