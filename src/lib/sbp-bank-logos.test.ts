import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SBP_BANKS } from './sbp-banks';

describe('Self-hosted bank logos', () => {
  test.each(SBP_BANKS.filter((bank) => bank.icon?.endsWith('.svg')))(
    'has a safe and local SVG logo for $name',
    ({ id }) => {
      const file = join(process.cwd(), 'public', 'banks', id + '.svg');
      const svg = readFileSync(file, 'utf8');
      expect(svg.length).toBeGreaterThan(100);
      expect(svg.length).toBeLessThan(20000);
      expect(svg).toContain('viewBox="0 0 40 40"');
      expect(svg).toContain('<path');
      expect(svg).not.toMatch(/<script|<foreignObject|<image|onload\s*=|onerror\s*=|xlink:href|<use\b/i);
      expect(svg).not.toMatch(/\bhref\s*=|url\(\s*https?:|data:/i);
    },
  );

  test('has icons for 185 of 195 banks and fallback for the remaining ten', () => {
    expect(SBP_BANKS).toHaveLength(195);
    const withLogo = SBP_BANKS.filter((bank) => bank.icon !== null);
    const fallback = SBP_BANKS.filter((bank) => bank.icon === null);
    expect(withLogo).toHaveLength(185);
    expect(fallback).toHaveLength(10);
    for (const bank of withLogo) {
      expect(bank.icon).toMatch(/^\/banks\/(?:[a-z]+\.svg|nspk\/\d{12}\.webp)$/);
      const asset = join(process.cwd(), 'public', bank.icon!.slice(1));
      expect(existsSync(asset), bank.id).toBe(true);
      if (bank.icon!.endsWith('.webp')) {
        const image = readFileSync(asset);
        expect(image.subarray(0, 4).toString()).toBe('RIFF');
        expect(image.subarray(8, 12).toString()).toBe('WEBP');
      }
    }
  });
});
