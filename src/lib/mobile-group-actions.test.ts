import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (filename: string) => readFileSync(resolve(process.cwd(), filename), 'utf8');

describe('Android group actions and account forms', () => {
  it('keeps invitation and settlement dialogs scrollable with keyboard-size viewport and safe bottom inset', () => {
    for (const [filename, testId] of [
      ['src/components/groups/invite-dialog.tsx', 'mobile-invite-dialog'],
      ['src/components/groups/settle-dialog.tsx', 'mobile-settle-dialog'],
    ] as const) {
      const ui = source(filename);
      expect(ui, filename).toContain('data-testid="' + testId + '"');
      expect(ui, filename).toContain('max-h-[calc(100dvh-2rem)]');
      expect(ui, filename).toContain('overflow-y-auto overscroll-contain');
      expect(ui, filename).toContain('env(safe-area-inset-bottom)');
    }
  });

  it('provides 44px settlement and invitation inputs, copy and confirmation actions', () => {
    const settle = source('src/components/groups/settle-dialog.tsx');
    expect(settle).not.toContain('flex h-9 w-full rounded-md border');
    expect(settle.match(/flex h-11 min-w-0 w-full rounded-md border/g)).toHaveLength(2);
    expect(settle).toContain('inputMode="decimal"');
    expect(settle).toContain('className="min-h-11 w-full text-base"');
    const invite = source('src/components/groups/invite-dialog.tsx');
    expect(invite).toContain('data-testid="mobile-copy-invite"');
    expect(invite).toContain('className="size-11 shrink-0"');
    expect(invite).toContain('h-11 min-w-0 flex-1');
    expect(invite).toContain('min-h-11 w-full');
  });

  it('makes profile and password fields touch-size with Android autofill attributes', () => {
    const profile = source('src/app/[locale]/(app)/settings/page.tsx');
    for (const value of [
      'autoComplete="email"',
      'autoComplete="name"',
      'autoComplete="current-password"',
      'autoComplete="new-password"',
    ]) {
      expect(profile).toContain(value);
    }
    expect(profile.match(/h-11 min-w-0 text-base/g)?.length).toBeGreaterThanOrEqual(6);
    expect(profile).toContain('data-testid="save-profile-btn"');
    expect(profile).toContain('className="min-h-11 w-full"');
  });
});
