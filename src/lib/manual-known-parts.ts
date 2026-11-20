import { manualPortionProgress } from './manual-receipt-split';

/**
 * Known original counts are optional, per receipt item. Item.quantity is the
 * purchased product count and must never substitute for an original part count.
 * Drafts may have an outstanding remainder, but cannot be saved over limit.
 * Finalization requires every known count to equal the actual declared parts.
 */
export function manualKnownPartsBalance(input: {
  itemIds: readonly string[];
  declaredTotalPartsByItem: unknown;
  assignments: readonly { receiptItemId: string; parts: readonly number[] }[];
}) {
  const raw = input.declaredTotalPartsByItem;
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new RangeError('Invalid original portion counts');
  }
  const limits = (raw ?? {}) as Record<string, unknown>;
  const claims = new Map<string, number[]>();
  for (const assignment of input.assignments) {
    const parts = claims.get(assignment.receiptItemId) ?? [];
    parts.push(...assignment.parts);
    claims.set(assignment.receiptItemId, parts);
  }
  const progressByItem: Record<string, { countedParts: number; remainingParts: number; overclaimed: boolean }> = {};
  let overclaimed = false;
  let hasRemaining = false;
  for (const id of input.itemIds) {
    const declared = limits[id];
    if (declared == null) continue;
    const result = manualPortionProgress(claims.get(id) ?? [], declared as number);
    const remaining = result.remainingParts!;
    progressByItem[id] = {
      countedParts: result.countedParts,
      remainingParts: remaining,
      overclaimed: result.overclaimed,
    };
    overclaimed ||= result.overclaimed;
    hasRemaining ||= remaining > 0;
  }
  return { progressByItem, overclaimed, hasRemaining };
}
