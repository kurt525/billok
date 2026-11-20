import { manualKnownPartsBalance } from './manual-known-parts';
import { guestPortionAssignments, type GuestPortionAssignment } from './guest-portions';

/** Optional original piece counts keyed by the stored, expanded guest item index.
 * These are not item.quantity and never represent money or an extra charge.
 */
export function guestKnownPartsBalance(input: {
  items: readonly unknown[];
  people: readonly { id?: string | undefined; groupSize?: number | undefined }[];
  assignments: readonly GuestPortionAssignment[];
  knownPartsByItem: unknown;
}) {
  const limits = input.knownPartsByItem;
  if (limits != null && (typeof limits !== 'object' || Array.isArray(limits))) {
    throw new RangeError('Invalid guest original portion counts');
  }
  if (limits != null) {
    for (const key of Object.keys(limits)) {
      const idx = Number(key);
      if (!Number.isSafeInteger(idx) || String(idx) !== key || idx < 0 || idx >= input.items.length) {
        throw new RangeError('Known parts reference a missing receipt item');
      }
    }
  }
  return manualKnownPartsBalance({
    itemIds: input.items.map((_, index) => String(index)),
    declaredTotalPartsByItem: limits,
    assignments: guestPortionAssignments(input.assignments, input.people).map((assignment) => ({
      receiptItemId: String(assignment.itemIndex),
      parts: assignment.portions ?? assignment.personIndices.map((index) => input.people[index]?.groupSize ?? 1),
    })),
  });
}
