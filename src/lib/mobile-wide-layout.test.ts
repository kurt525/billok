import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

describe('Wide Android and Galaxy S23 mobile layout', () => {
  it('centers a readable single-column app on wide phones and unfolded small mobile displays', () => {
    const app = source('src/app/[locale]/(app)/layout.tsx');
    expect(app).toContain('mx-auto w-full min-w-0 max-w-xl px-4 py-4');
    expect(app).toContain('<MobileHeader isAdmin={isAdmin} />');
    expect(app).not.toContain('<AppSidebar');
    expect(app).not.toContain('lg:flex-row');
    expect(app).not.toContain('2xl:max-w-5xl');
  });

  it('aligns mobile navigation with the same content width without shrinking the menu button', () => {
    const header = source('src/components/layout/mobile-header.tsx');
    expect(header).toContain('mx-auto flex h-14 w-full max-w-xl items-center justify-between');
    expect(header).toContain('className="size-11"');
    expect(header).not.toContain('lg:hidden');
  });

  it('keeps navigation below Android status-bar safe areas without shrinking 44px touch targets', () => {
    const header = source('src/components/layout/mobile-header.tsx');
    const split = source('src/app/[locale]/split/layout.tsx');
    const locale = source('src/app/[locale]/layout.tsx');
    expect(locale).toContain("viewportFit: 'cover'");
    expect(header).toContain('pt-[env(safe-area-inset-top)]');
    expect(header).toContain('flex h-14 w-full max-w-xl');
    expect(split).toContain('pt-[env(safe-area-inset-top)]');
    expect(split).toContain('flex h-14 max-w-lg');
    expect(split).toContain('inline-flex min-h-11');
  });

  it('keeps group creation one-handed with 44px controls and an accessible selected emoji', () => {
    const form = source('src/app/[locale]/(app)/groups/new/page.tsx');
    expect(form).toContain('mx-auto min-w-0 max-w-lg');
    expect(form.match(/className="h-11 min-w-0 text-base"/g)).toHaveLength(2);
    expect(form).toContain('flex size-11 shrink-0 items-center justify-center');
    expect(form).toContain('aria-pressed={emoji === e}');
    expect(form).toContain('aria-label={e}');
    expect(form).toContain("currency: 'RUB'");
    expect(form).not.toContain('select');
    expect(form).not.toContain('COMMON_CURRENCIES');
    expect(form).toContain('className="min-h-11 w-full text-base"');
  });

  it('disables group currency editing without changing currencies in existing records', () => {
    const settings = source('src/app/[locale]/(app)/groups/[groupId]/settings/page.tsx');
    expect(settings).not.toContain('COMMON_CURRENCIES');
    expect(settings).not.toContain('select');
    expect(settings).toContain('data-testid="group-currency-readonly"');
    expect(settings).toContain("initialCurrency === 'RUB'");
    expect(settings).not.toContain('currency: currency || undefined');
    expect(settings).toContain('description: description || undefined');
  });

  it('wraps unbroken names of other claimants without expanding the receipt on large-font phones', () => {
    const claim = source('src/app/[locale]/split/[token]/claim/page.tsx');
    expect(claim).toContain('mt-1 flex min-w-0 flex-wrap items-center gap-1');
    expect(claim).toContain('min-w-0 flex-1 text-xs text-muted-foreground [overflow-wrap:anywhere]');
    expect(claim).toContain("otherClaimants.map((pi) => data.people[pi]?.name ?? '?').join(', ')");
  });

  it('keeps rare admin clean-up controls touch-sized with wrapping titles on mobile', () => {
    const admin = source('src/app/[locale]/(app)/admin/page.tsx');
    expect(admin.match(/<CardTitle className="flex flex-wrap items-center justify-between gap-2">/g)).toHaveLength(2);
    expect(admin.match(/className="min-h-11 min-w-11 whitespace-normal leading-tight"/g)).toHaveLength(2);
    expect(admin).toContain('onClick={() => cleanup.mutate()}');
    expect(admin).toContain('onClick={() => cleanupUnused.mutate()}');
  });

  it('keeps both guest header navigation links at least 44px high', () => {
    const header = source('src/app/[locale]/split/layout.tsx');
    expect(header).toContain('inline-flex min-h-11 items-center gap-2');
    expect(header.match(/inline-flex min-h-11 min-w-11 items-center justify-center/g)).toHaveLength(2);
  });

  it('keeps authentication and guest receipts one column regardless of wide phone viewport', () => {
    const auth = source('src/app/[locale]/(auth)/layout.tsx');
    const split = source('src/app/[locale]/split/layout.tsx');
    expect(auth).toContain('max-w-md');
    expect(split).toContain('max-w-lg');
  });
});
