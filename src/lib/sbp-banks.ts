/** Initial SBP directory. Logos/search and a full bank catalogue follow separately. */
export const SBP_BANKS = [
  { id: 'sberbank', name: 'СберБанк' },
  { id: 'tbank', name: 'Т-Банк' },
  { id: 'vtb', name: 'ВТБ' },
  { id: 'alfabank', name: 'Альфа-Банк' },
  { id: 'gazprombank', name: 'Газпромбанк' },
  { id: 'akbars', name: 'Ак Барс Банк' },
  { id: 'sovcombank', name: 'Совкомбанк' },
  { id: 'raiffeisen', name: 'Райффайзенбанк' },
] as const;

export function isSupportedSbpBankId(id: string): boolean {
  return SBP_BANKS.some((bank) => bank.id === id);
}

/** Normalize an unverified Russian phone for account profile storage. */
export function normalizeSbpPhone(value: string): string | null {
  const stripped = value.trim().replace(/[\s()\-]/g, '');
  if (/^\+7\d{10}$/.test(stripped)) return stripped;
  if (/^[78]\d{10}$/.test(stripped)) return '+7' + stripped.slice(1);
  return null;
}
