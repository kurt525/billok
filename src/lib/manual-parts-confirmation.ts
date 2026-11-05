/**
 * Canonical receipt-wide snapshot the creator explicitly approves before
 * finishing a manual group receipt. This is not an authorization token:
 * server authorization and comparison are performed under the receipt lock.
 * Prices and actual consumers are included so any change invalidates approval.
 */
export function manualPartsConfirmationSnapshot(input: {
  items: readonly { id: string; totalPrice: number }[];
  assignments: readonly {
    receiptItemId: string;
    people: readonly { userId: string; parts: number }[];
  }[];
}): string {
  return JSON.stringify({
    items: input.items
      .map((item) => [item.id, item.totalPrice])
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
