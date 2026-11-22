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

/** Presentation only: never change the saved summary or its person indices. */
export function personalReceiptTotals<T extends { personIndex: number }>(
  summary: readonly T[],
  people: readonly Person[],
  actorId: string | null,
  isCreator: boolean,
): { person: T; muted: boolean }[] {
  const actor = people.find((person) => person.id === actorId);
  if (!actor) return summary.map((person) => ({ person, muted: false }));
  const representative = actor.paymentGroupRepresentativeId === actor.id;
  const rank = (entry: T) => {
    const person = people[entry.personIndex];
    if (person?.id === actor.id) return 0;
    if (representative && person?.paymentGroupRepresentativeId === actor.id) return 1;
    return 2;
  };
  return [...summary]
    .sort((a, b) => rank(a) - rank(b))
    .map((person) => ({
      person,
      muted: !isCreator && rank(person) === 2,
    }));
}
