import { describe, expect, test } from 'vitest';
import { appendDelegatedReceiptAudit, authorizeReceiptPersonEdit } from './guest-group-delegation';
import type { GuestSessionPerson } from './guest-people';

const payer = '11111111-1111-4111-8111-111111111101';
const wife = '11111111-1111-4111-8111-111111111102';
const husband = '11111111-1111-4111-8111-111111111103';
const child = '11111111-1111-4111-8111-111111111104';
const stranger = '11111111-1111-4111-8111-111111111105';
const family = [
  { id: payer, name: 'Payer', personToken: 'payer-secret' },
  { id: wife, name: 'Wife', personToken: 'wife-secret', paymentGroupRepresentativeId: wife },
  { id: husband, name: 'Husband', personToken: 'husband-secret', paymentGroupRepresentativeId: wife },
  { id: child, name: 'Child', paymentGroupRepresentativeId: wife },
  { id: stranger, name: 'Other', personToken: 'other-secret' },
];

describe('Issue 3.24.1.3: representative authorizes edits within a single group', () => {
  test('wife can edit for husband and child without their login or phone', () => {
    expect(authorizeReceiptPersonEdit(family, 0, 'wife-secret', child)).toEqual({
      actorIndex: 1,
      targetIndex: 3,
      delegated: true,
    });
    expect(authorizeReceiptPersonEdit(family, 0, 'wife-secret', husband)).toMatchObject({
      actorIndex: 1,
      targetIndex: 2,
      delegated: true,
    });
  });

  test('husband and ungrouped guest retain self edits but cannot represent anyone else', () => {
    expect(authorizeReceiptPersonEdit(family, 0, 'husband-secret', husband)).toMatchObject({
      targetIndex: 2,
      delegated: false,
    });
    expect(authorizeReceiptPersonEdit(family, 0, 'other-secret', stranger)).toMatchObject({
      targetIndex: 4,
      delegated: false,
    });
    for (const token of ['husband-secret', 'other-secret', 'payer-secret', 'unknown-token']) {
      expect(() => authorizeReceiptPersonEdit(family, 0, token, child)).toThrow();
    }
    expect(() => authorizeReceiptPersonEdit(family, 0, 'wife-secret', stranger)).toThrow();
  });

  test('leader revoked by reassignment cannot use old token to edit the family', () => {
    const changed = family.map((person) =>
      person.paymentGroupRepresentativeId === wife ? { ...person, paymentGroupRepresentativeId: husband } : person,
    );
    expect(() => authorizeReceiptPersonEdit(changed, 0, 'wife-secret', child)).toThrow();
    expect(authorizeReceiptPersonEdit(changed, 0, 'husband-secret', child)).toMatchObject({
      actorIndex: 2,
      targetIndex: 3,
      delegated: true,
    });
  });

  test('invalid group topology never grants delegation', () => {
    const invalid = family.map((person) =>
      person.id === wife ? { ...person, paymentGroupRepresentativeId: payer } : person,
    );
    expect(() => authorizeReceiptPersonEdit(invalid, 0, 'wife-secret', child)).toThrow();
  });

  test('ungrouped receipts allow delegated claims only when the caller has verified creator rights', () => {
    const individual = family.map(({ paymentGroupRepresentativeId: unused, ...person }) => {
      void unused;
      return person;
    });
    expect(authorizeReceiptPersonEdit(individual, 0, 'wife-secret', child, true)).toMatchObject({
      actorIndex: 1,
      targetIndex: 3,
      delegated: false,
    });
    expect(() => authorizeReceiptPersonEdit(individual, 0, 'wife-secret', child)).toThrow();
  });

  test('audits actor, target, action and timestamp without tokens, bounded to 20 entries', () => {
    let target: GuestSessionPerson = family[3]!;
    for (let index = 0; index < 25; index++) {
      target = appendDelegatedReceiptAudit(target, wife, child, 'item-parts', index);
    }
    expect(target.delegatedReceiptAudit).toHaveLength(20);
    expect(target.delegatedReceiptAudit?.[0]).toEqual({
      actorId: wife,
      targetId: child,
      action: 'item-parts',
      itemIndex: 5,
      at: expect.any(String),
    });
    expect(JSON.stringify(target.delegatedReceiptAudit)).not.toContain('secret');
  });
});
