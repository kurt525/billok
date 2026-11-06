import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GuestAccountStatus } from './guest-account-status';

const labels = { registeredLabel: 'Зарегистрирован', guestLabel: 'Гость' };

describe('Issue 3.11: registered person vs guest is visible without reliance on color or names', () => {
  test('account-bound participant has distinct icon and visible registered label', () => {
    const html = renderToStaticMarkup(createElement(GuestAccountStatus, { ...labels, isRegistered: true }));
    expect(html).toContain('Зарегистрирован');
    expect(html).toContain('account-status-registered');
    expect(html).toContain('lucide-user-round-check');
    expect(html).not.toContain('account-status-guest');
    expect(html).not.toContain('>Гость<');
  });

  test('anonymous bearer-token user is explicitly a guest with a different icon', () => {
    const html = renderToStaticMarkup(createElement(GuestAccountStatus, { ...labels, isRegistered: false }));
    expect(html).toContain('Гость');
    expect(html).toContain('account-status-guest');
    expect(html).toContain('lucide-user-round');
    expect(html).not.toContain('account-status-registered');
  });

  test('both types have visible text, not color-only symbols or receipt-role badges', () => {
    for (const isRegistered of [true, false]) {
      const html = renderToStaticMarkup(createElement(GuestAccountStatus, { ...labels, isRegistered }));
      expect(html).toContain('<span>');
      expect(html).not.toContain('receipt-role-creator');
      expect(html).not.toContain('receipt-role-payer');
    }
  });
});
