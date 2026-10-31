import { defaultLocale } from '@/i18n/routing';

/** Maximum monetary value in cents — Postgres int4 max, the DB column type for all money fields. */
export const MAX_MONEY_CENTS = 2_147_483_647;

const moneyLocales: Record<string, string> = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
  sv: 'sv-SE',
  fr: 'fr-FR',
  de: 'de-DE',
  'pt-BR': 'pt-BR',
  ja: 'ja-JP',
  'zh-CN': 'zh-CN',
  ko: 'ko-KR',
};

export function formatCents(cents: number, currency = 'RUB', locale: string = defaultLocale): string {
  return new Intl.NumberFormat(moneyLocales[locale] ?? locale, {
    style: 'currency',
    currency,
  }).format(cents / 100);
}

/** A human-entered amount, allowing Russian comma decimals and grouped thousands. */
export function isValidMoneyInput(value: string): boolean {
  const trimmed = value.trim().replace(/[\u00a0\u202f]/g, ' ');
  return /^-?(?:\d+|\d{1,3}(?: \d{3})+)(?:[.,]\d+)?$/.test(trimmed);
}

export function parseToCents(value: string): number {
  // Never interpret the Russian decimal comma as a thousands separator.
  if (!isValidMoneyInput(value)) return 0;
  const normalized = value
    .trim()
    .replace(/[ \u00a0\u202f]/g, '')
    .replace(',', '.');
  const negative = normalized.startsWith('-');
  const abs = negative ? normalized.slice(1) : normalized;
  const dotIndex = abs.lastIndexOf('.');
  if (dotIndex === -1) return (parseInt(abs, 10) || 0) * 100 * (negative ? -1 : 1);
  const intPart = abs.slice(0, dotIndex) || '0';
  const fraction = abs.slice(dotIndex + 1);
  const fracPart = fraction.padEnd(2, '0').slice(0, 2);
  // Integer-string half-up rounding: no binary floating-point 1.005 → 1.00 error.
  const roundUp = (fraction[2] ?? '0') >= '5' ? 1 : 0;
  const cents = (parseInt(intPart, 10) || 0) * 100 + parseInt(fracPart, 10) + roundUp;
  return cents * (negative ? -1 : 1);
}

export function centsToDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}
