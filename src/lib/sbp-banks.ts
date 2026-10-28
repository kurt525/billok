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

/** Search is limited to the curated bank list. Historical names are search
 * aliases only and are not themselves bank identifiers or payment endpoints. */
const SBP_BANK_SEARCH_ALIASES: Partial<Record<(typeof SBP_BANKS)[number]['id'], string[]>> = {
  sberbank: ['сбер', 'сбербанк'],
  tbank: ['тинькофф', 'тинькофф банк', 't-bank', 'tbank'],
  alfabank: ['альфа', 'alpha bank'],
  gazprombank: ['гпб'],
  akbars: ['акбарс', 'ак барс'],
  sovcombank: ['совком'],
  raiffeisen: ['райффайзен'],
};

function normalizeBankSearch(value: string): string {
  return value
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[\s\-–—]+/g, '')
    .trim();
}

export function searchSbpBanks(query: string): (typeof SBP_BANKS)[number][] {
  const normalized = normalizeBankSearch(query);
  if (!normalized) return [...SBP_BANKS];
  return SBP_BANKS.filter((bank) =>
    [bank.name, ...(SBP_BANK_SEARCH_ALIASES[bank.id] ?? [])].some((name) =>
      normalizeBankSearch(name).includes(normalized),
    ),
  );
}

/** Normalize an unverified Russian phone for account profile storage. */
export function normalizeSbpPhone(value: string): string | null {
  const stripped = value.trim().replace(/[\s()\-]/g, '');
  if (/^\+7\d{10}$/.test(stripped)) return stripped;
  if (/^[78]\d{10}$/.test(stripped)) return '+7' + stripped.slice(1);
  return null;
}
