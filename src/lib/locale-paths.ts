// Russian-only canonical URLs. next-intl internally uses /ru/* to render pages.
function splitPathSuffix(path: string) {
  const suffixIndex = path.search(/[?#]/);
  if (suffixIndex === -1) return { pathname: path, suffix: '' };
  return { pathname: path.slice(0, suffixIndex), suffix: path.slice(suffixIndex) };
}

export function isSafeInternalPath(path: string | null): path is string {
  return !!path && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\');
}

/** Strip only next-intl's internal Russian prefix, not defunct ShareTab languages. */
export function stripLocalePrefix(path: string): string {
  const { pathname, suffix } = splitPathSuffix(path);
  if (pathname !== '/ru' && !pathname.startsWith('/ru/')) return path;
  return `${pathname.slice(3) || '/'}${suffix}`;
}

/** Keep Passkey post-login redirects local and usable in Russian-only BillOK. */
export function normalizeCallbackPath(rawCallbackUrl: string | null): string {
  if (!isSafeInternalPath(rawCallbackUrl)) return '/dashboard';
  const canonical = stripLocalePrefix(rawCallbackUrl);
  // Stale links with an unsupported language (including old pt-BR, zh-CN)
  // must not send an authenticated user to a nonexistent route.
  if (/^\/[a-z]{2}(?:-[a-z]{2})?(?:\/|[?#]|$)/iu.test(canonical)) return '/dashboard';
  return canonical;
}
