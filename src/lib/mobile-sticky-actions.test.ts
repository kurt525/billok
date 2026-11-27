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

describe('Responsive guest sharing actions in a separate tab', () => {
  it('keeps links reachable in normal flow without a fixed footer', () => {
    const ui = read('src/app/[locale]/split/[token]/page.tsx');
    expect(ui).toContain('max-[399px]:flex-col');
    expect(ui).toContain('pb-[calc(1rem+env(safe-area-inset-bottom))]');
    expect(
      ui.match(/className="min-h-14 min-w-0 w-full flex-1 whitespace-normal text-center leading-tight"/g),
    ).toHaveLength(2);
    expect(ui).toContain('data-testid="split-result-actions"');
    expect(ui).toContain('aria-labelledby="claim-links-tab"');
    expect(ui).toContain("hidden={tab !== 'links'}");
    expect(ui).not.toContain('fixed inset-x-0 bottom-0 z-10');
    expect(ui).not.toContain('copyToClipboard(window.location.href)');
  });

  it('keeps links separate from both distribution tabs and the finalized settlement', () => {
    const claim = read('src/app/[locale]/split/[token]/claim/page.tsx');
    const tabs = read('src/components/receipt-tabs.tsx');
    expect(tabs).toContain("'grid-cols-3'");
    expect(tabs).toContain("label: t('tabsLinks')");
    expect(claim).toContain('data-testid="claim-links-panel"');
    expect(claim).toContain("hidden={activeTab !== 'links'}");
    expect(claim).toContain('{linksPanel(finalizedTab, true)}');
    expect(claim).toContain('{linksPanel(joinTab)}');
    expect(claim).toContain('{linksPanel(receiptTab)}');
    expect(claim.match(/creatorGuestLinkControls\(person, idx\)/g)).toHaveLength(1);
    expect(claim.match(/data-testid="copy-link-btn"/g)).toHaveLength(1);
  });
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

describe('Android confirmation dialogs on compact viewports', () => {
  it('keeps destructive-action confirmation and cancellation reachable with internal scrolling', () => {
    const dialog = read('src/components/ui/alert-dialog.tsx');
    expect(dialog).toContain('data-slot="alert-dialog-content"');
    expect(dialog).toContain('max-h-[calc(100dvh-2rem)]');
    expect(dialog).toContain('overflow-y-auto overscroll-contain');
    expect(dialog).toContain('pb-[calc(1rem+env(safe-area-inset-bottom))]');
  });
});

describe('TASK-BILLOK-003: per-item mobile actions have no obsolete fixed claim save', () => {
  it('leaves summary and tip fields scrollable and keeps only necessary finalization controls', () => {
    const claim = read('src/app/[locale]/split/[token]/claim/page.tsx');
    expect(claim).toContain('data-testid="claim-actions"');
    expect(claim).toContain('pb-[env(safe-area-inset-bottom)]');
    expect(claim).not.toContain('fixed inset-x-0 bottom-0 z-40 isolate');
    expect(claim).not.toContain('data-testid="save-claims-btn"');
    expect(claim).toContain('max-w-full');
  });
});
