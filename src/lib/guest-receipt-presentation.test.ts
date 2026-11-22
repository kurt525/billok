import { describe, expect, it } from 'vitest';
import {
  canEditReceiptPerson,
  personalReceiptSections,
  personalReceiptTotals,
  flatPeopleOrder,
} from './guest-receipt-presentation';

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
      [0, true],
      [3, true],
      [4, true],
    ]);
    expect(view('outsider')).toEqual([
      [2, false],
      [0, true],
      [3, true],
      [1, true],
      [4, true],
    ]);
    expect(summary.map((p) => p.personIndex)).toEqual([2, 4, 0, 1, 3]);
  });
  it('puts leader first, then only their members, then unrelated diners', () => {
    expect(view('leader')).toEqual([
      [3, false],
      [1, false],
      [4, false],
      [2, true],
      [0, true],
    ]);
  });
  it('does not mute an author overview or guess missing identity', () => {
    expect(view(null)).toEqual([
      [2, false],
      [0, false],
      [3, false],
      [1, false],
      [4, false],
    ]);
    expect(view('removed')).toEqual(view(null));
    expect(view('author', true)).toEqual([
      [0, false],
      [2, false],
      [3, false],
      [1, false],
      [4, false],
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

describe('Issue 19 sections 15–16: two or more groups, personal and representative order', () => {
  const many = [
    { id: 'author' },
    { id: 'andrey', paymentGroupRepresentativeId: 'andrey' },
    { id: 'guest2', paymentGroupRepresentativeId: 'andrey' },
    { id: 'guest3', paymentGroupRepresentativeId: 'guest3' },
    { id: 'guest4', paymentGroupRepresentativeId: 'guest3' },
    { id: 'guest5' },
  ];
  const sums = many.map((_, personIndex) => ({ personIndex, total: (personIndex + 1) * 100 }));
  const ids = (actor: string | null) =>
    personalReceiptTotals(sums, many, actor, actor === 'author').map(({ person }) => many[person.personIndex]!.id);
  it('author own first, independent people next, each group below with representative first', () => {
    expect(ids('author')).toEqual(['author', 'guest5', 'andrey', 'guest2', 'guest3', 'guest4']);
    const sections = personalReceiptSections(sums, many, 'author', true);
    expect(sections.filter((s) => s.representativeId).map((s) => s.representativeId)).toEqual(['andrey', 'guest3']);
    expect(sections.flatMap((s) => s.members).length).toBe(sums.length);
    expect(sums.map((s) => s.personIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it('group representative sees their group first, before separate people and other groups', () => {
    expect(ids('andrey')).toEqual(['andrey', 'guest2', 'author', 'guest5', 'guest3', 'guest4']);
    expect(ids('guest3')).toEqual(['guest3', 'guest4', 'author', 'guest5', 'andrey', 'guest2']);
  });
  it('ordinary member own first without duplicate, own group stays below independent people', () => {
    expect(ids('guest2')).toEqual(['guest2', 'author', 'guest5', 'andrey', 'guest3', 'guest4']);
    const sections = personalReceiptSections(sums, many, 'guest2', false);
    expect(sections.find((s) => s.representativeId === 'andrey')?.detachedOwnMember).toBe(true);
    expect(sections.flatMap((s) => s.members).map((s) => s.person.personIndex)).toHaveLength(6);
  });
  it('unknown viewer sees independent people first and cannot pretend another identity', () => {
    expect(ids(null)).toEqual(['author', 'guest5', 'andrey', 'guest2', 'guest3', 'guest4']);
    expect(ids('foreign')).toEqual(ids(null));
  });
  it('all-people tab is flat and own-first, never grouped or duplicated', () => {
    expect(flatPeopleOrder(many, 'guest4')).toEqual([4, 0, 1, 2, 3, 5]);
    expect(flatPeopleOrder(many, null)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(flatPeopleOrder(many, 'other')).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it('changing representative preserves money and independent order', () => {
    const changed = many.map((p) =>
      p.paymentGroupRepresentativeId === 'andrey' ? { ...p, paymentGroupRepresentativeId: 'guest2' } : p,
    );
    const sections = personalReceiptSections(sums, changed, 'author', true);
    expect(sections.find((s) => s.representativeId === 'guest2')?.members.map((x) => x.person.personIndex)).toEqual([
      2, 1,
    ]);
    expect(sums.map((p) => p.total)).toEqual([100, 200, 300, 400, 500, 600]);
  });
});
