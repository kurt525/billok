import bankCatalog from './sbp-bank-catalog.json';

/**
 * Snapshot of the NSPK C2B bank registry, via eav93/sbp (2026-10-28).
 * This is a bank *selector*, not a claim of C2C transfer availability.
 * Keep the eight original IDs stable for existing BillOK user profiles.
 */
export interface SbpBank {
  id: string;
  name: string;
  nspkId: string;
  icon: string | null;
  active?: boolean;
  sourceName?: string;
}

export const SBP_BANKS: SbpBank[] = bankCatalog.banks;
export const SBP_BANK_CATALOG_UPDATED_AT = bankCatalog.sourceUpdatedAt;

/** Only present banks should be available for new selections. Retired bank IDs remain in the catalog for existing profiles. */
export function isSupportedSbpBankId(id: string): boolean {
  return SBP_BANKS.some((bank) => bank.id === id && bank.active !== false);
}

/** Search bank names and familiar aliases; aliases never become payment endpoints. */
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
  if (!normalized) return SBP_BANKS.filter((bank) => bank.active !== false);
  return SBP_BANKS.filter(
    (bank) =>
      bank.active !== false &&
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
