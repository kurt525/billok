/**
 * Assignments use stable person IDs for personal portions. An index changes
 * when a participant ahead of someone is removed; their UUID does not.
 */
export type GuestPortionAssignment = {
  itemIndex: number;
  personIndices: number[];
  partsByPersonId?: Record<string, number> | undefined;
};

export function guestPortionAssignments(
  assignments: readonly GuestPortionAssignment[],
  people: readonly { id?: string | undefined; groupSize?: number | undefined }[],
): { itemIndex: number; personIndices: number[]; portions?: number[] }[] {
  return assignments.map((assignment) => {
    const stored = assignment.partsByPersonId;
    if (!stored || Object.keys(stored).length === 0) {
      return { itemIndex: assignment.itemIndex, personIndices: assignment.personIndices };
    }
    const portions = assignment.personIndices.map((index) => {
      const person = people[index];
      if (!person?.id) throw new RangeError('Missing guest identity');
      const parts = stored[person.id] ?? person.groupSize ?? 1;
      if (!Number.isSafeInteger(parts) || parts < 1 || parts > 10000) {
        throw new RangeError('Invalid guest portion count');
      }
      return parts;
    });
    return { itemIndex: assignment.itemIndex, personIndices: assignment.personIndices, portions };
  });
}

export function guestPortionProgress(
  assignment: GuestPortionAssignment,
  people: readonly { id?: string | undefined; groupSize?: number | undefined }[],
  originalParts?: number | null,
) {
  const result = guestPortionAssignments([assignment], people)[0]!;
  const weights = result.portions ?? result.personIndices.map((i) => people[i]?.groupSize ?? 1);
  const countedParts = weights.reduce((sum, count) => sum + count, 0);
  if (originalParts == null) return { countedParts, remainingParts: null };
  if (!Number.isSafeInteger(originalParts) || originalParts < 1) throw new RangeError('Invalid original count');
  return { countedParts, remainingParts: originalParts - countedParts };
}
