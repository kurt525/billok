import { guestPortionAssignments, type GuestPortionAssignment } from './guest-portions';

/**
 * Canonical material for creator sign-off on the *current* guest receipt.
 * Per-person tokens, names, voluntary tips and payment metadata are excluded.
 * A new part, consumer, price, item or group-size makes the approval stale.
 */
export function guestPartsConfirmationSnapshot(input: {
  items: readonly { name: string; quantity: number; totalPrice: number }[];
  people: readonly { id?: string | undefined; groupSize?: number | undefined }[];
  assignments: readonly GuestPortionAssignment[];
}): string {
  const portions = guestPortionAssignments(input.assignments, input.people);
  return JSON.stringify({
    items: input.items.map((item) => [item.name, item.quantity, item.totalPrice]),
    people: input.people
      .map((person) => [person.id ?? '', person.groupSize ?? 1])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
    portions: portions
      .map((assignment) => [
        assignment.itemIndex,
        assignment.personIndices
          .map((personIndex, index) => [
            input.people[personIndex]?.id ?? '',
            assignment.portions?.[index] ?? input.people[personIndex]?.groupSize ?? 1,
          ])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ])
      .sort(([a], [b]) => Number(a) - Number(b)),
  });
}
