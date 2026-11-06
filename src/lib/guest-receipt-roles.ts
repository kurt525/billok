/**
 * Receipt roles belong to actual participant rows. The organizer comes from
 * the immutable organizerPersonId on this receipt, never from an account's
 * administrator status, person's name, or the payer's identity.
 */
export function organizerPersonIndex(
  people: readonly { id?: string }[],
  organizerPersonId: string | undefined,
): number {
  return typeof organizerPersonId === 'string' && organizerPersonId.length > 0
    ? people.findIndex((person) => person.id === organizerPersonId)
    : -1;
}

export function guestReceiptRoleFlags(index: number, organizerIndex: number, paidByIndex: number, peopleCount: number) {
  const valid = Number.isSafeInteger(index) && index >= 0 && index < peopleCount;
  return {
    isCreator: valid && index === organizerIndex,
    isPayer: valid && index === paidByIndex,
  };
}
