import { describe, expect, test } from 'vitest';
import { assignPersonIds, findTargetIndex, hasPersonIds, newGuestPersonId, personIdSchema } from './guest-people';

const ID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_B = 'aaaaaaaa-0000-4000-8000-000000000002';
const ID_C = 'aaaaaaaa-0000-4000-8000-000000000003';

describe('hasPersonIds', () => {
  test('is true when every person has an id', () => {
    expect(
      hasPersonIds([
        { id: ID_A, name: 'A' },
        { id: ID_B, name: 'B' },
      ]),
    ).toBe(true);
  });

  test('is false when anyone was saved before person ids existed', () => {
    expect(hasPersonIds([{ id: ID_A, name: 'A' }, { name: 'B' }])).toBe(false);
  });

  test('treats an empty id as missing', () => {
    expect(hasPersonIds([{ id: '', name: 'A' }])).toBe(false);
  });

  test("treats an id that isn't a UUID as missing (requests can only name people by UUID)", () => {
    expect(hasPersonIds([{ id: 'not-a-uuid', name: 'A' }])).toBe(false);
  });
});

describe('assignPersonIds', () => {
  test('gives each person without an id a new one and keeps existing ids', () => {
    let n = 0;
    const ids = [ID_B, ID_C];
    const people = assignPersonIds(
      [{ id: ID_A, name: 'A', personToken: 't' }, { name: 'B', groupSize: 2 }, { name: 'C' }],
      () => ids[n++]!,
    );
    expect(people).toEqual([
      { id: ID_A, name: 'A', personToken: 't' },
      { id: ID_B, name: 'B', groupSize: 2 },
      { id: ID_C, name: 'C' },
    ]);
  });

  test("replaces an id that isn't a UUID", () => {
    expect(assignPersonIds([{ id: 'not-a-uuid', name: 'A' }], () => ID_A)).toEqual([{ id: ID_A, name: 'A' }]);
  });

  test('mints distinct random UUIDs by default', () => {
    const people = assignPersonIds([{ name: 'A' }, { name: 'B' }]);
    expect(people[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(people[0]!.id).not.toBe(people[1]!.id);
  });
});

describe('Issue #1 3.25.1: guest personId must not be guessable or reused in a receipt', () => {
  test('validates exclusively UUIDv4 (not time-based UUIDv1, UUIDv7 or sequential numbers)', () => {
    expect(personIdSchema.safeParse(ID_A).success).toBe(true);
    expect(personIdSchema.safeParse('aaaaaaaa-0000-1000-8000-000000000001').success).toBe(false);
    expect(personIdSchema.safeParse('aaaaaaaa-0000-7000-8000-000000000001').success).toBe(false);
    expect(personIdSchema.safeParse('1').success).toBe(false);
    expect(personIdSchema.safeParse('aaaaaaaa-0000-4000-8000-000000000001-extra').success).toBe(false);
  });

  test('generates independent random UUIDv4 for 100 guests, revealing no ordinal guest count', () => {
    const existing = new Set<string>();
    for (let index = 0; index < 100; index++) {
      const id = newGuestPersonId(existing);
      expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      expect(existing.has(id)).toBe(false);
      existing.add(id);
    }
    // A person in a DIFFERENT receipt receives an independent identity.
    expect(existing.has(newGuestPersonId([]))).toBe(false);
  });

  test('retries CSPRNG collisions against earlier guests without changing their IDs', () => {
    let index = 0;
    const generator = () => [ID_A, ID_A, ID_B][index++]!;
    expect(newGuestPersonId([ID_A], generator)).toBe(ID_B);
    expect(index).toBe(3);
  });

  test('rejects a repeatedly colliding, malformed or non-v4 generator rather than returning a duplicate', () => {
    expect(() => newGuestPersonId([ID_A], () => ID_A)).toThrow('уникальный');
    expect(() => newGuestPersonId([], () => 'guest-1')).toThrow('уникальный');
    expect(() => newGuestPersonId([], () => 'aaaaaaaa-0000-1000-8000-000000000001')).toThrow('уникальный');
  });

  test('marks duplicate or time-based legacy identities invalid even if every row has a UUID', () => {
    expect(
      hasPersonIds([
        { id: ID_A, name: 'Alice' },
        { id: ID_A, name: 'Bob' },
      ]),
    ).toBe(false);
    expect(hasPersonIds([{ id: 'aaaaaaaa-0000-1000-8000-000000000001', name: 'Old' }])).toBe(false);
  });

  test('repairs duplicate IDs, preserving the first person, names, parts and private session fields', () => {
    const people = assignPersonIds(
      [
        { id: ID_A, name: 'Alice', personToken: 'secret-A', tipCents: 123 },
        { id: ID_A, name: 'Bob', personToken: 'secret-B', tipCents: 500 },
        { id: ID_B, name: 'Charlie' },
      ],
      () => ID_C,
    );
    expect(people).toEqual([
      { id: ID_A, name: 'Alice', personToken: 'secret-A', tipCents: 123 },
      { id: ID_C, name: 'Bob', personToken: 'secret-B', tipCents: 500 },
      { id: ID_B, name: 'Charlie' },
    ]);
    expect(hasPersonIds(people)).toBe(true);
  });

  test('reserves the IDs of people later in the array before filling missing guest slots', () => {
    let n = 0;
    const ids = [ID_B, ID_C];
    const people = assignPersonIds([{ name: 'Free slot' }, { id: ID_B, name: 'Existing' }], () => ids[n++]!);
    expect(people.map((person) => person.id)).toEqual([ID_C, ID_B]);
  });

  test('retains a UUIDv4 across rename, reordering and changes to parts and group membership', () => {
    const people = assignPersonIds([
      { id: ID_A, name: 'Илья', groupSize: 2 },
      { id: ID_B, name: 'Гость 1', tipCents: 0 },
    ]);
    const moved = assignPersonIds([
      { ...people[1]!, name: 'Ольга', tipCents: 125 },
      { ...people[0]!, groupSize: 1 },
    ]);
    expect(moved[0]!.id).toBe(ID_B);
    expect(moved[1]!.id).toBe(ID_A);
  });
});

describe('findTargetIndex', () => {
  // B was removed: C moved down one place
  const people = [
    { id: ID_A, name: 'A' },
    { id: ID_C, name: 'C' },
  ];

  test('finds a person by id wherever they are now', () => {
    expect(findTargetIndex(people, ID_C)).toBe(1);
  });

  test('is -1 for an id nobody has (the person was removed)', () => {
    expect(findTargetIndex(people, ID_B)).toBe(-1);
  });

  test('never matches a person without an id', () => {
    const noIds: { id?: string; name: string }[] = [{ name: 'A' }];
    expect(findTargetIndex(noIds, ID_A)).toBe(-1);
  });
});
