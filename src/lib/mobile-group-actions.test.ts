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
    expect(invite).toContain('className="size-12 shrink-0"');
    expect(invite).toContain('h-11 min-w-0 flex-1');
    expect(invite).toContain('min-h-12 w-full');
  });

  it('keeps profile name and SBP controls touch-size without password fields', () => {
    const profile = source('src/app/[locale]/(app)/settings/page.tsx');
    for (const value of ['autoComplete="email"', 'autoComplete="off"']) {
      expect(profile).toContain(value);
    }
    expect(profile).not.toContain('autoComplete="name"');
    expect(profile).not.toContain('type="password"');
    expect(profile.match(/h-11 min-w-0 (?:scroll-mt-20 )?text-base/g)?.length).toBeGreaterThanOrEqual(4);
    for (const [id, testId] of [
      ['sbp-phone', 'sbp-phone-input'],
      ['sbp-bank-search', 'sbp-bank-search'],
    ] as const) {
      const start = profile.indexOf('id="' + id + '"');
      expect(start).toBeGreaterThanOrEqual(0);
      const end = profile.indexOf('/>', start);
      expect(end).toBeGreaterThan(start);
      const inputMarkup = profile.slice(start, end);
      expect(inputMarkup).toContain('className="h-11 min-w-0 scroll-mt-20 text-base"');
      expect(inputMarkup).toContain('data-testid="' + testId + '"');
    }
    expect(profile).toContain('data-testid="save-profile-btn"');
    expect(profile).toContain('className="min-h-11 w-full"');
  });
});

describe('Mobile payment history and safe confirmation', () => {
  it('wraps participants, notes and amounts without shrinking touch targets', () => {
    const ui = source('src/components/groups/payments-list.tsx');
    expect(ui).not.toContain('className="truncate"');
    expect(ui).not.toContain('size="icon-sm"');
    for (const token of [
      'flex min-w-0 flex-wrap items-center justify-between gap-3',
      '[overflow-wrap:anywhere]',
      'size-11 shrink-0',
      'className="mt-2 min-h-11"',
      'data-testid="mobile-payment-delete-dialog"',
      'max-h-[calc(100dvh-2rem)]',
      'overflow-y-auto overscroll-contain',
      'env(safe-area-inset-bottom)',
      'className="min-h-11 min-w-11"',
    ]) {
      expect(ui).toContain(token);
    }
  });
});

describe('BillOK receipt-bound payments (mobile presentation only)', () => {
  it('removes legacy free-form settlement actions from the group screen', () => {
    const page = source('src/app/[locale]/(app)/groups/[groupId]/page.tsx');
    expect(page).not.toContain('<SettleDialog');
    expect(page).not.toContain('group-debt-settlement-button');
    expect(page).not.toContain('group-settle-all-button');
    expect(page).toContain('data-testid="group-debt-row"');
  });

  it('uses the calculated receipt debt rather than an editable transfer amount', () => {
    const receipt = source('src/app/[locale]/split/[token]/claim/page.tsx');
    const payer = source('src/components/guest-payer-payment-review.tsx');
    const participant = source('src/components/guest-payment-declaration.tsx');
    expect(receipt).toContain('data-testid="guest-personal-reimbursement-amount"');
    expect(receipt).toContain('formatCents(personalReimbursement.total, currency, locale)');
    expect(receipt).not.toContain('id="settle-amount"');
    expect(payer).toContain('data-testid="guest-payer-payment-amount"');
    expect(participant).toContain('data-testid="guest-mark-paid"');
  });

  it('keeps payment history and cancellation visible on small phones', () => {
    const list = source('src/components/groups/payments-list.tsx');
    expect(list).toContain('data-testid="payment-note"');
    expect(list).toContain('data-testid="payment-amount"');
    expect(list).toContain('data-testid="cancel-delete-payment"');
    expect(list).toContain('data-testid="mobile-payment-delete-dialog"');
    expect(list).toContain('max-h-[calc(100dvh-2rem)]');
    expect(list).toContain('size-11 shrink-0');
  });
});
