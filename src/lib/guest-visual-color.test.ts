import { describe, expect, test } from 'vitest';
import {
  guestVisualColorBorder,
  guestVisualColorKey,
  guestVisualColorStyle,
  GUEST_OWNER_COLOR_ID,
  GUEST_OWNER_FILL,
  GUEST_OWNER_BORDER,
  GUEST_PALETTE_V2_BASE,
} from './guest-visual-color';

describe('3.9 stable per-person visual markers', () => {
  const alice = { id: 'aaaaaaaa-0000-4000-8000-000000000001', visualColorId: 0 };
  const bob = { id: 'aaaaaaaa-0000-4000-8000-000000000002', visualColorId: 1 };

  test('different people have different accents, stable after list reordering', () => {
    expect(guestVisualColorBorder(alice)).not.toBe(guestVisualColorBorder(bob));
    expect(guestVisualColorStyle(alice, 0)).toEqual(guestVisualColorStyle(alice, 19));
    expect(guestVisualColorBorder(bob, 1)).toBe(guestVisualColorBorder(bob, 0));
  });

  test('changing the name leaves the same marker', () => {
    const before = { ...bob, name: 'Андрей' };
    const after = { ...bob, name: 'Андрей П.' };
    expect(guestVisualColorStyle(before)).toEqual(guestVisualColorStyle(after));
  });

  test('100 guest places have 100 unique accent colors', () => {
    const colors = Array.from({ length: 100 }, (_, i) => guestVisualColorBorder({ visualColorId: i }));
    expect(new Set(colors).size).toBe(100);
  });

  test('legacy fallback hashes stable UUID independent of index', () => {
    const legacy = { id: 'aaaaaaaa-0000-4000-8000-000000000001' };
    expect(guestVisualColorKey(legacy, 2)).toBe(guestVisualColorKey(legacy, 44));
    expect(guestVisualColorBorder(legacy, 1)).toBe(guestVisualColorBorder(legacy, 90));
  });

  test('the text and background are deliberately high contrast', () => {
    for (const visualColorId of [0, 1, 2, 9, 25, 60, 99]) {
      const style = guestVisualColorStyle({ visualColorId });
      expect(style.color).toBe('#172033');
      expect(style.backgroundColor).toMatch(/^hsl\([\d.]+ \d+% 8[36]%\)$/);
      expect(style.borderColor).toMatch(/^hsl\([\d.]+ 77% 38%\)$/);
    }
  });
});

describe('Issue #19: perceptual palette and server-reserved owner blue', () => {
  const guest = (index: number) => ({ visualColorId: GUEST_PALETTE_V2_BASE + index });
  test('owner has the screenshot-confirmed permanent blue, not a role-dependent green', () => {
    expect(guestVisualColorStyle({ visualColorId: GUEST_OWNER_COLOR_ID })).toEqual({
      backgroundColor: '#BFDBFE',
      color: '#172033',
      borderColor: '#2563EB',
    });
    expect(GUEST_OWNER_FILL).toBe('#BFDBFE');
    expect(GUEST_OWNER_BORDER).toBe('#2563EB');
  });
  test.each([2, 5, 10, 20, 30, 100])('the first %i guest colors remain unique, including borders', (count) => {
    const fills = Array.from({ length: count }, (_, i) => guestVisualColorStyle(guest(i)).backgroundColor);
    const borders = Array.from({ length: count }, (_, i) => guestVisualColorBorder(guest(i)));
    expect(new Set(fills).size).toBe(count);
    expect(new Set(borders).size).toBe(count);
    expect(fills).not.toContain(GUEST_OWNER_FILL);
    expect(borders).not.toContain(GUEST_OWNER_BORDER);
  });
  test('first ten use separated hues; first twenty avoid reserved owner-blue hue', () => {
    const hues = Array.from({ length: 20 }, (_, i) => {
      const hsl = guestVisualColorStyle(guest(i)).backgroundColor;
      const found = /^hsl\((\d+(?:\.\d+)?) /.exec(hsl);
      expect(found).not.toBeNull();
      return Number(found![1]);
    });
    const arc = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
    for (let i = 0; i < 10; i++) for (let j = 0; j < i; j++) expect(arc(hues[i]!, hues[j]!)).toBeGreaterThanOrEqual(25);
    for (let i = 0; i < 20; i++) expect(arc(hues[i]!, 212)).toBeGreaterThanOrEqual(28);
  });
  test('new and old receipts keep their colors stable across rename, role and reordering', () => {
    const saved = { id: 'aaaaaaaa-0000-4000-8000-000000000002', visualColorId: GUEST_PALETTE_V2_BASE + 8 };
    expect(guestVisualColorStyle(saved)).toEqual(guestVisualColorStyle({ ...saved }));
    expect(guestVisualColorStyle(saved, 99)).toEqual(guestVisualColorStyle(saved, 0));
    expect(guestVisualColorStyle({ visualColorId: 1 }).backgroundColor).toBe('hsl(137.508 63% 83%)');
    expect(guestVisualColorBorder({ visualColorId: 1 })).toBe('hsl(137.508 77% 38%)');
    expect(guestVisualColorStyle({ visualColorId: GUEST_PALETTE_V2_BASE + 1 })).not.toEqual(
      guestVisualColorStyle({ visualColorId: 1 }),
    );
  });
});
