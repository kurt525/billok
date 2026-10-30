import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

describe('Mobile manual receipt action bar and Android keyboard', () => {
  it('keeps both steps within the dynamic viewport with scrollable safe-area actions', () => {
    const guest = read('src/app/[locale]/split/page.tsx');
    expect(guest).toContain('data-testid="guest-assign-actions"');
    expect(guest.match(/max-h-\[calc\(100dvh-1rem\)\] overflow-y-auto overscroll-contain/g)).toHaveLength(2);
    expect(guest.match(/pb-\[calc\(1rem\+env\(safe-area-inset-bottom\)\)\]/g)).toHaveLength(2);
    expect(guest).not.toContain('fixed right-0 bottom-0 left-0 border-t bg-background p-4');
  });
});

describe('Android guest result and claim actions', () => {
  for (const [file, testid, bottomSpace] of [
    ['src/app/[locale]/split/[token]/page.tsx', 'split-result-actions', '7rem'],
    ['src/app/[locale]/split/[token]/claim/page.tsx', 'claim-actions', '10rem'],
  ] as const) {
    it(file + ': keeps bottom actions reachable above Android navigation and small keyboard viewports', () => {
      const ui = read(file);
      expect(ui).toContain('data-testid="' + testid + '"');
      expect(ui).toContain('fixed inset-x-0 bottom-0 z-10');
      expect(ui).toContain('max-h-[calc(100dvh-1rem)]');
      expect(ui).toContain('overflow-y-auto overscroll-contain');
      expect(ui).toContain('pb-[calc(1rem+env(safe-area-inset-bottom))]');
      expect(ui).toContain('pb-[calc(' + bottomSpace + '+env(safe-area-inset-bottom))]');
      expect(ui).not.toContain('fixed bottom-0 left-0 right-0 p-4 bg-background border-t');
    });
  }
});

describe('Standard BillOK dialogs on small Android viewports', () => {
  it('keeps dialog contents and confirmation controls scrollable above Android navigation and keyboard', () => {
    const dialog = read('src/components/ui/dialog.tsx');
    expect(dialog).toContain('data-slot="dialog-content"');
    expect(dialog).toContain('max-h-[calc(100dvh-2rem)]');
    expect(dialog).toContain('overflow-y-auto overscroll-contain');
    expect(dialog).toContain('pb-[calc(1rem+env(safe-area-inset-bottom))]');
  });
});
