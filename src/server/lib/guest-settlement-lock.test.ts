import { describe, expect, it } from 'vitest';
import {
  assertGuestDeclaredAmountsUnchanged,
  assertGuestSettlementUnchanged,
  guestSettlementDigest,
} from './guest-settlement-lock';

const payer = { id: 'payer-id', name: 'Плательщик', personToken: 'private-payer' };
const anna = { id: 'anna-id', name: 'Анна', personToken: 'private-anna' };
const boris = { id: 'boris-id', name: 'Борис' };
const shares = [
  { personIndex: 0, total: 459, tip: 59 },
  { personIndex: 1, total: 742, tip: 42 },
  { personIndex: 2, total: 408, tip: 8 },
];
const settled = { people: [anna, payer, boris], paidByIndex: 1, summary: shares, receiptTotalCents: 1500 };
const lock = { version: 1, lockedAt: '2026-11-10T14:00:00.000Z', digest: guestSettlementDigest(settled) };

describe('Issue #1 5.20: finalized payment settlement remains immutable', () => {
  it('locks original exact cents, payer identity and each person’s share, not a rounded/estimated amount', () => {
    expect(lock.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      assertGuestSettlementUnchanged({ ...settled, receiptData: { paymentSettlementLock: lock } }),
    ).not.toThrow();
    for (const modified of [
      { ...settled, receiptTotalCents: 1501 },
      { ...settled, paidByIndex: 0 },
      { ...settled, summary: [{ ...shares[0]!, total: 458 }, shares[1]!, { ...shares[2]!, total: 409 }] },
      { ...settled, summary: [{ ...shares[0]!, tip: 58 }, shares[1]!, { ...shares[2]!, tip: 9 }] },
      { ...settled, people: [boris, payer, anna] },
      { ...settled, people: [{ ...anna, paymentGroupRepresentativeId: 'boris-id' }, payer, boris] },
    ]) {
      expect(() =>
        assertGuestSettlementUnchanged({ ...modified, receiptData: { paymentSettlementLock: lock } }),
      ).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }));
    }
  });

  it('does not block personal token rotation or name changes, and supports older finalized receipts', () => {
    const rotated = {
      ...settled,
      people: [{ ...anna, name: 'Анна-2', personToken: 'rotated' }, { ...payer, name: 'Борис' }, boris],
      summary: [...shares].reverse(),
    };
    expect(guestSettlementDigest(rotated)).toBe(lock.digest);
    expect(() =>
      assertGuestSettlementUnchanged({ ...rotated, receiptData: { paymentSettlementLock: lock } }),
    ).not.toThrow();
    expect(() => assertGuestSettlementUnchanged({ ...rotated, receiptData: {} })).not.toThrow();
    expect(() =>
      assertGuestSettlementUnchanged({
        ...rotated,
        receiptData: { paymentSettlementLock: { version: 1, digest: 'bad' } },
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }));
  });

  it('never silently assigns an old declared amount to a new group or personal debt', () => {
    const people = [
      { ...anna, paymentDeclaredAt: '2026-11-10T14:03:00Z', paymentDeclaredAmountCents: 459 },
      payer,
      boris,
    ];
    expect(() =>
      assertGuestDeclaredAmountsUnchanged({
        people,
        paidByIndex: 1,
        summary: shares,
        groupDebts: null,
      }),
    ).not.toThrow();
    expect(() =>
      assertGuestDeclaredAmountsUnchanged({
        people,
        paidByIndex: 1,
        summary: [{ ...shares[0]!, total: 500 }, shares[1]!, shares[2]!],
        groupDebts: null,
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }));
    expect(() =>
      assertGuestDeclaredAmountsUnchanged({
        people,
        paidByIndex: 1,
        summary: shares,
        groupDebts: [{ representativeId: 'anna-id', totalCents: 867 }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }));
  });
});
