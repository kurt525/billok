import { locales, type Locale } from '@/i18n/routing';

// Redirect bookmarked ShareTab language-prefixed routes without losing guest tokens or query strings.
const legacyLocales = ['ru', 'en', 'es', 'sv', 'fr', 'de', 'pt-BR', 'ja', 'zh-CN', 'ko'] as const;

function splitPathSuffix(path: string) {
  const suffixIndex = path.search(/[?#]/);
  if (suffixIndex === -1) return { pathname: path, suffix: '' };
  return { pathname: path.slice(0, suffixIndex), suffix: path.slice(suffixIndex) };
}

export function isSafeInternalPath(path: string | null): path is string {
  return !!path && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\');
}

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return !!value && locales.includes(value as Locale);
}

export function hasLocalePrefix(path: string): boolean {
  const { pathname } = splitPathSuffix(path);
  return legacyLocales.some((locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`));
}

export function stripLocalePrefix(path: string): string {
  const { pathname, suffix } = splitPathSuffix(path);
  const locale = legacyLocales.find((value) => pathname === `/${value}` || pathname.startsWith(`/${value}/`));
  if (!locale) return path;
  const stripped = pathname.slice(locale.length + 1);
  return `${stripped.startsWith('/') ? stripped : '/' + stripped}${suffix}`;
}

/** Legacy clients may send a language prefix, but BillOK's canonical routes never have one. */
export function withLocalePrefix(path: string, locale: Locale): string {
  // The locale argument is retained for older callers, but never changes the URL.
  void locale;
  return stripLocalePrefix(path.startsWith('/') ? path : `/${path}`);
}

export function normalizeCallbackPath(rawCallbackUrl: string | null, locale: Locale): string {
  if (!isSafeInternalPath(rawCallbackUrl)) return '/dashboard';
  return withLocalePrefix(rawCallbackUrl, locale);
}
