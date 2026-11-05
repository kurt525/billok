/**
 * Canonical receipt-wide snapshot the creator explicitly approves before
 * finishing a manual group receipt. This is not an authorization token:
 * server authorization and comparison are performed under the receipt lock.
 * Prices and actual consumers are included so any change invalidates approval.
 */
export function manualPartsConfirmationSnapshot(input: {
  items: readonly { id: string; totalPrice: number }[];
  declaredTotalPartsByItem?: unknown;
  assignments: readonly {
    receiptItemId: string;
    people: readonly { userId: string; parts: number }[];
  }[];
}): string {
  return JSON.stringify({
    items: input.items
      .map((item) => [item.id, item.totalPrice])
      .sort(([idA], [idB]) => String(idA).localeCompare(String(idB))),
    knownParts: input.items
      .filter(
        (item) =>
          input.declaredTotalPartsByItem != null &&
          typeof input.declaredTotalPartsByItem === 'object' &&
          !Array.isArray(input.declaredTotalPartsByItem) &&
          Object.hasOwn(input.declaredTotalPartsByItem, item.id),
      )
      .map((item) => [item.id, (input.declaredTotalPartsByItem as Record<string, unknown>)[item.id]])
      .sort(([idA], [idB]) => String(idA).localeCompare(String(idB))),
    assignments: input.assignments
      .map((assignment) => [
        assignment.receiptItemId,
        assignment.people
          .map((person) => [person.userId, person.parts])
          .sort(([idA], [idB]) => String(idA).localeCompare(String(idB))),
      ])
      .sort(([idA], [idB]) => String(idA).localeCompare(String(idB))),
  });
}
