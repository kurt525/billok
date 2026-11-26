import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/app/[locale]/(app)/splits/page.tsx'), 'utf8');

const renameEditor = readFileSync(resolve(process.cwd(), 'src/components/receipt-title-editor.tsx'), 'utf8');

describe('Mobile split history', () => {
  it('keeps the rename touch target independent of the stretched receipt link', () => {
    const renameButton = renameEditor.match(
      /className="([^"]+)"\s+aria-label=\{t\('rename'\)\}\s+data-testid="receipt-rename-open"/,
    );
    expect(renameButton).not.toBeNull();
    expect(renameButton![1]!.split(/\s+/)).toEqual(expect.arrayContaining(['size-11', 'shrink-0', 'relative', 'z-10']));
    expect(page).toContain('after:absolute after:inset-0');
    expect(page).toContain('split.canRename && <ReceiptTitleEditor');
  });

  it('uses a single column rather than a 280px minimum grid on 320px phones', () => {
    expect(page).toContain('grid min-w-0 grid-cols-1 gap-4');
    expect(page).not.toContain('minmax(280px,1fr)');
    expect(page).toContain('flex min-w-0 flex-wrap items-center justify-between gap-3');
  });

  it('keeps full receipt names visible without pushing cards or amounts offscreen', () => {
    expect(page).toContain('min-w-0 flex-1 [overflow-wrap:anywhere]');
    expect(page).not.toContain('flex-1 truncate');
    expect(page).toContain('tabular-nums [overflow-wrap:anywhere]');
  });

  it('provides 44px delete, new-receipt and load-more touch targets', () => {
    const deleteButton = page.match(
      /className="([^"]+)"\s+aria-label=\{t\('delete'\)\}\s+data-testid=\{`delete-split-/,
    );
    expect(deleteButton).not.toBeNull();
    expect(deleteButton![1]!.split(/\s+/)).toEqual(
      expect.arrayContaining(['flex', 'size-11', 'items-center', 'justify-center', 'shrink-0']),
    );
    expect(page).toContain('className="min-h-11"');
    expect(page).toContain('className="mt-4 min-h-11"');
  });
});
