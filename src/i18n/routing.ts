import { defineRouting } from 'next-intl/routing';

// BillOK is Russian-only. Do not negotiate a locale from the user's browser or account.
export const locales = ['ru'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'ru';

export const routing = defineRouting({
  locales,
  defaultLocale,
  localePrefix: 'never',
  localeDetection: false,
});
