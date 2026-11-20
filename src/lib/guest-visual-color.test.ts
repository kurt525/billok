import { describe, expect, test } from 'vitest';
import { guestVisualColorBorder, guestVisualColorKey, guestVisualColorStyle } from './guest-visual-color';

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
