import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('BillOK Russian-only user-facing fallbacks', () => {
  it('does not expose English errors or receipt titles in guest and group flows', () => {
    const groupScan = source('src/app/[locale]/(app)/groups/[groupId]/scan/page.tsx');
    const claim = source('src/app/[locale]/split/[token]/claim/page.tsx');
    expect(groupScan).not.toContain("'Unknown'");
    expect(claim).not.toContain("'Bill split'");
    expect(claim).toContain("'Разделение чека'");
  });

  it('shows Russian notifications rather than raw network exceptions when creating bills', () => {
    const guest = source('src/app/[locale]/split/page.tsx');
    const grouped = source('src/app/[locale]/(app)/groups/[groupId]/scan/page.tsx');
    expect(guest).toContain("toast.error(t('assign.createSplitFailed'))");
    expect(guest).toContain("toast.error(t('assign.createSessionFailed'))");
    expect(grouped).toContain("toast.error(t('createSessionFailed'))");
    expect(guest).not.toContain("err instanceof Error ? err.message : t('assign.create");
    expect(grouped).not.toContain("err instanceof Error ? err.message : t('createSessionFailed')");
  });

  it('uses Russian fallback for settings mutations and inline errors', () => {
    const settings = source('src/app/[locale]/(app)/groups/[groupId]/settings/page.tsx');
    expect(settings).toContain("localizedTrpcError(e, tc('errors.generic'))");
    expect(settings).toContain("localizedTrpcError(updateGroup.error, tc('errors.generic'))");
    expect(settings).not.toContain('toast.error(e.message)');
    expect(settings).not.toContain('{updateGroup.error.message}');
    expect(settings).not.toContain(' : e.message');
  });

  it('redirects the landing page to canonical locale-free destinations', () => {
    const root = source('src/app/[locale]/page.tsx');
    expect(root).toContain("'/dashboard'");
    expect(root).toContain("'/login'");
    expect(root).not.toContain('/${locale}/');
  });

  it('localizes administrator login errors and uses unprefixed redirects', () => {
    const admin = source('src/app/[locale]/(app)/admin/page.tsx');
    expect(admin).not.toContain('MeridianAuthSection');
    expect(admin).not.toContain('OpenAICodexAuthSection');
    expect(admin).not.toContain('AIProviderTestSection');
    const users = source('src/components/admin/user-management-section.tsx');
    expect(users).not.toContain('Impersonation failed');
    expect(users).toContain("window.location.assign(new URL('/dashboard', window.location.origin).href)");
    expect(users).not.toContain("window.location.pathname.split('/')");
  });

  it('localizes announcement accessibility labels and default dialog close', () => {
    const banner = source('src/components/layout/announcement-banner.tsx');
    const dialog = source('src/components/ui/dialog.tsx');
    expect(banner).toContain('aria-label="Скрыть объявление"');
    expect(banner).not.toContain('Dismiss announcement');
    expect(dialog).toContain("t('actions.close')");
    expect(dialog).not.toContain('>Close</DialogPrimitive.Close>');
  });
});

describe('BillOK small Android viewport static contracts', () => {
  it('uses device viewport with keyboard resizing and safe-area support', () => {
    const layout = source('src/app/[locale]/layout.tsx');
    expect(layout).toContain("width: 'device-width'");
    expect(layout).toContain("viewportFit: 'cover'");
    expect(layout).toContain("interactiveWidget: 'resizes-content'");
  });

  it('provides a fixed-size tap target and wraps long announcement text at 320–412 px', () => {
    const banner = source('src/components/layout/announcement-banner.tsx');
    expect(banner).toContain('h-10 w-10');
    expect(banner).toContain('min-w-0 flex-1 break-words');
    expect(banner).toContain('shrink-0');
  });

  it('keeps mobile navigation tap targets at least 44 CSS pixels high', () => {
    const menu = source('src/components/layout/mobile-header.tsx');
    const theme = source('src/components/layout/theme-toggle.tsx');
    const sheet = source('src/components/ui/sheet.tsx');

    expect(menu).toContain('className="size-11"');
    expect(menu).toContain('min-h-11');
    expect(menu).toContain('min-h-0 flex-1 space-y-1 overflow-y-auto');
    expect(menu).toContain('<ThemeToggle className="size-11" />');
    expect(theme).toContain('className={className}');
    expect(sheet).toContain('absolute top-2 right-2 size-11');
  });

  it('keeps mobile navigation and guest header reachable without desktop-only layouts', () => {
    const header = source('src/components/layout/mobile-header.tsx');
    const splitLayout = source('src/app/[locale]/split/layout.tsx');
    expect(header).toContain('lg:hidden');
    expect(header).toContain('<Sheet');
    expect(splitLayout).toContain('min-h-[100dvh]');
    expect(splitLayout).toContain('px-4');
  });
});
