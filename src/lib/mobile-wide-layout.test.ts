import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

describe('Wide Android and Galaxy S23 mobile layout', () => {
  it('centers a readable single-column app on wide phones and unfolded small mobile displays', () => {
    const app = source('src/app/[locale]/(app)/layout.tsx');
    expect(app).toContain('max-lg:mx-auto max-lg:max-w-xl');
    expect(app).toContain('w-full px-4 py-4');
    expect(app).toContain('lg:overflow-auto');
  });

  it('aligns mobile navigation with the same content width without shrinking the menu button', () => {
    const header = source('src/components/layout/mobile-header.tsx');
    expect(header).toContain('mx-auto flex h-full w-full max-w-xl items-center justify-between');
    expect(header).toContain('className="size-11"');
    expect(header).toContain('lg:hidden');
  });

  it('keeps group creation one-handed with 44px controls and an accessible selected emoji', () => {
    const form = source('src/app/[locale]/(app)/groups/new/page.tsx');
    expect(form).toContain('mx-auto min-w-0 max-w-lg');
    expect(form.match(/className="h-11 min-w-0 text-base"/g)).toHaveLength(2);
    expect(form).toContain('flex size-11 shrink-0 items-center justify-center');
    expect(form).toContain('aria-pressed={emoji === e}');
    expect(form).toContain('aria-label={e}');
    expect(form).toContain('flex h-11 min-w-0 w-full rounded-md');
    expect(form).toContain('className="min-h-11 w-full text-base"');
  });

  it('keeps authentication and guest receipts one column regardless of wide phone viewport', () => {
    const auth = source('src/app/[locale]/(auth)/layout.tsx');
    const split = source('src/app/[locale]/split/layout.tsx');
    expect(auth).toContain('max-w-md');
    expect(split).toContain('max-w-lg');
  });
});
