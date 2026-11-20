/** Whole, positive receipt item quantity. Never silently truncate '2.5' to 2. */
export function parseReceiptQuantity(input: string): number | null {
  const value = input.trim();
  if (!/^[1-9]\d*$/.test(value)) return null;
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) ? quantity : null;
}
