import { describe, expect, it } from 'vitest';
import { canEditReceiptPerson, personalReceiptTotals } from './guest-receipt-presentation';

const people = [
  { id: 'author' },
  { id: 'member', paymentGroupRepresentativeId: 'leader' },
  { id: 'outsider' },
  { id: 'leader', paymentGroupRepresentativeId: 'leader' },
  { id: 'child', paymentGroupRepresentativeId: 'leader' },
];
const summary = [2, 4, 0, 1, 3].map((personIndex) => ({ personIndex, total: personIndex * 100 }));
const view = (actor: string | null, creator = false) =>
  personalReceiptTotals(summary, people, actor, creator).map(({ person, muted }) => [person.personIndex, muted]);

describe('Issue #19 section 9: personal final receipt presentation', () => {
  it('puts own card first, keeps others in saved order and never rewrites ledger', () => {
    expect(view('member')).toEqual([
      [1, false],
      [2, true],
      [4, true],
      [0, true],
      [3, true],
    ]);
    expect(view('outsider')).toEqual([
      [2, false],
      [4, true],
      [0, true],
      [1, true],
      [3, true],
    ]);
    expect(summary.map((p) => p.personIndex)).toEqual([2, 4, 0, 1, 3]);
  });
  it('puts leader first, then only their members, then unrelated diners', () => {
    expect(view('leader')).toEqual([
      [3, false],
      [4, false],
      [1, false],
      [2, true],
      [0, true],
    ]);
  });
  it('does not mute an author overview or guess missing identity', () => {
    expect(view(null)).toEqual([
      [2, false],
      [4, false],
      [0, false],
      [1, false],
      [3, false],
    ]);
    expect(view('removed')).toEqual(view(null));
    expect(view('author', true)).toEqual([
      [0, false],
      [2, false],
      [4, false],
      [1, false],
      [3, false],
    ]);
  });
  it('does not synthesize a financial row for a non-consuming viewer', () => {
    const sparse = summary.filter((p) => p.personIndex !== 1);
    expect(personalReceiptTotals(sparse, people, 'member', false).every((p) => p.muted)).toBe(true);
  });
});

describe('Issue #19 section 10: colors follow existing edit permissions', () => {
  const editable = (
    actor: string | null,
    creator = false,
    rows: { id: string; paymentGroupRepresentativeId?: string }[] = people,
  ) => rows.filter((p) => canEditReceiptPerson(rows, actor, creator, p.id)).map((p) => p.id);
  it('ordinary member and outsider see only own color', () => {
    expect(editable('member')).toEqual(['member']);
    expect(editable('outsider')).toEqual(['outsider']);
  });
  it('leader sees group, but a verified author can edit every row even when grouped', () => {
    expect(editable('leader')).toEqual(['member', 'leader', 'child']);
    expect(editable('author', true)).toEqual(people.map((p) => p.id));
    expect(editable(null, true)).toEqual(people.map((p) => p.id));
    expect(editable('member', true)).toEqual(people.map((p) => p.id));
    expect(editable(null)).toEqual([]);
  });
  it('ungrouped authorized author sees all colors; others only own', () => {
    const rows = people.map(({ id }) => ({ id }));
    expect(editable('author', true, rows)).toEqual(rows.map((p) => p.id));
    expect(editable('member', false, rows)).toEqual(['member']);
  });
});
