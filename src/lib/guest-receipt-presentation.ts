type Person = { id: string; paymentGroupRepresentativeId?: string | undefined };

export function canEditReceiptPerson(
  people: readonly Person[],
  actorId: string | null,
  isCreator: boolean,
  targetId: string,
): boolean {
  // Creator role is server-verified; payment groups never take away the
  // creator's receipt allocation rights. Guests still need own/group identity.
  if (isCreator) return people.some((person) => person.id === targetId);
  return (
    !!actorId &&
    (targetId === actorId ||
      (people.find((person) => person.id === actorId)?.paymentGroupRepresentativeId === actorId &&
        people.some((person) => person.id === targetId && person.paymentGroupRepresentativeId === actorId)))
  );
}

/**
 * Presentation-only grouping. Never rearrange the saved people/summary,
 * person indices, share links, roles or individual ledger entries.
 * A viewer's personal card is first. Separate diners follow, with other
 * groups at the bottom, their representative always above group members.
 */
export type ReceiptDisplaySection<T> = {
  key: string;
  representativeId: string | null;
  representativeNameIndex: number | null;
  detachedOwnMember: boolean;
  members: { person: T; muted: boolean }[];
};

export function personalReceiptSections<T extends { personIndex: number }>(
  summary: readonly T[],
  people: readonly Person[],
  actorId: string | null,
  isCreator: boolean,
): ReceiptDisplaySection<T>[] {
  const actorIndex = people.findIndex((person) => person.id === actorId);
  const actor = actorIndex < 0 ? null : people[actorIndex]!;
  const actorIsLeader = !!actor && actor.paymentGroupRepresentativeId === actor.id;
  const rows = summary
    .map((person) => ({
      person,
      target: people[person.personIndex],
    }))
    .filter((row) => !!row.target);
  const muted = (row: (typeof rows)[number]) =>
    !!actor &&
    !isCreator &&
    row.target?.id !== actor.id &&
    !(actorIsLeader && row.target?.paymentGroupRepresentativeId === actor.id);
  const sections: ReceiptDisplaySection<T>[] = [];
  const added = new Set<number>();
  const singleton = (row: (typeof rows)[number]) => {
    if (added.has(row.person.personIndex)) return;
    added.add(row.person.personIndex);
    sections.push({
      key: 'person:' + row.target!.id,
      representativeId: null,
      representativeNameIndex: null,
      detachedOwnMember: false,
      members: [{ person: row.person, muted: muted(row) }],
    });
  };
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const leader = row.target?.paymentGroupRepresentativeId;
    if (!leader) continue;
    const list = groups.get(leader) ?? [];
    list.push(row);
    groups.set(leader, list);
  }
  // A representative's group is a single first section; other members of
  // a group have their own card first, with no repeated copy in group block.
  if (actor && !actorIsLeader) {
    const own = rows.find((row) => row.target?.id === actor.id);
    if (own) singleton(own);
  }
  const groupOrder = [...groups.keys()];
  if (actorIsLeader) {
    groupOrder.sort((a, b) => Number(b === actor!.id) - Number(a === actor!.id));
  }
  // Show an actor-led group first, then independent diners, then all
  // foreign groups. Never put a foreign group ahead of independent diners.
  const emitGroup = (leader: string) => {
    const members = (groups.get(leader) ?? []).filter((row) => !added.has(row.person.personIndex));
    if (!members.length) return;
    members.sort(
      (a, b) =>
        Number(b.target?.id === leader) - Number(a.target?.id === leader) ||
        a.person.personIndex - b.person.personIndex,
    );
    const representativeNameIndex = people.findIndex((person) => person.id === leader);
    const section: ReceiptDisplaySection<T> = {
      key: 'group:' + leader,
      representativeId: leader,
      representativeNameIndex: representativeNameIndex >= 0 ? representativeNameIndex : null,
      detachedOwnMember: !!actor && !actorIsLeader && actor.paymentGroupRepresentativeId === leader,
      members: members.map((row) => ({ person: row.person, muted: muted(row) })),
    };
    sections.push(section);
    for (const member of members) added.add(member.person.personIndex);
  };
  if (actorIsLeader) emitGroup(actor!.id);
  for (const row of rows) if (!row.target?.paymentGroupRepresentativeId) singleton(row);
  for (const leader of groupOrder) {
    if (actorIsLeader && leader === actor!.id) continue;
    emitGroup(leader);
  }
  // Invalid legacy group mappings must not hide a financial row.
  for (const row of rows) if (!added.has(row.person.personIndex)) singleton(row);
  return sections;
}

/** Existing consumer gets the flattened card sequence and privacy dimming. */
export function personalReceiptTotals<T extends { personIndex: number }>(
  summary: readonly T[],
  people: readonly Person[],
  actorId: string | null,
  isCreator: boolean,
): { person: T; muted: boolean }[] {
  return personalReceiptSections(summary, people, actorId, isCreator).flatMap((section) => section.members);
}

/** Flat, own-first people list. No visible group blocks or group labels. */
export function flatPeopleOrder(people: readonly Person[], actorId: string | null): number[] {
  const result = people.map((_, index) => index);
  const actorIndex = people.findIndex((person) => person.id === actorId);
  if (actorIndex >= 0) result.sort((a, b) => Number(b === actorIndex) - Number(a === actorIndex));
  return result;
}
