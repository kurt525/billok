/** A phone keyboard may provide a comma. Reject partial/ambiguous values rather than parseFloat('50foo') == 50. */
export function parseRussianPercentage(value: string): number | null {
  const raw = value.trim();
  if (!/^(?:\d+)(?:[.,]\d{1,2})?$/.test(raw)) return null;
  const number = Number(raw.replace(',', '.'));
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}
