import { describe, expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GuestReceiptRoles } from './guest-receipt-roles';

const labels = { creatorLabel: 'Создатель', payerLabel: 'Плательщик' };

describe('Issue 3.10: accessible role markers', () => {
  test('creator alone shows crown plus visible label, never a payer marker', () => {
    const html = renderToStaticMarkup(createElement(GuestReceiptRoles, { ...labels, isCreator: true, isPayer: false }));
    expect(html).toContain('👑');
    expect(html).toContain('Создатель');
    expect(html).toContain('receipt-role-creator');
    expect(html).not.toContain('receipt-role-payer');
  });

  test('payer alone shows money bundle plus visible label, never creator', () => {
    const html = renderToStaticMarkup(createElement(GuestReceiptRoles, { ...labels, isCreator: false, isPayer: true }));
    expect(html).toContain('💵');
    expect(html).toContain('Плательщик');
    expect(html).toContain('receipt-role-payer');
    expect(html).not.toContain('receipt-role-creator');
  });

  test('same person displays both distinct role icons and text', () => {
    const html = renderToStaticMarkup(createElement(GuestReceiptRoles, { ...labels, isCreator: true, isPayer: true }));
    expect(html).toContain('👑');
    expect(html).toContain('💵');
    expect(html).toContain('Создатель');
    expect(html).toContain('Плательщик');
    expect(html.match(/receipt-role-/g)?.length).toBe(2);
  });

  test('ordinary participants receive no role icons', () => {
    expect(
      renderToStaticMarkup(createElement(GuestReceiptRoles, { ...labels, isCreator: false, isPayer: false })),
    ).toBe('');
  });
});
