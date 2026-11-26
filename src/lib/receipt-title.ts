export const MAX_RECEIPT_TITLE_LENGTH = 120;

export function normalizeReceiptTitle(value: string): string | null {
  const title = value.trim();
  return title.length > 0 && title.length <= MAX_RECEIPT_TITLE_LENGTH ? title : null;
}
