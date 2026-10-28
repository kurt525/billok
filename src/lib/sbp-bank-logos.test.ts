import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SBP_BANKS } from './sbp-banks';

describe('Self-hosted bank logos', () => {
  test.each(SBP_BANKS)('has a safe and local SVG logo for $name', ({ id }) => {
    const file = join(process.cwd(), 'public', 'banks', id + '.svg');
    const svg = readFileSync(file, 'utf8');
    expect(svg.length).toBeGreaterThan(100);
    expect(svg.length).toBeLessThan(20000);
    expect(svg).toContain('viewBox="0 0 40 40"');
    expect(svg).toContain('<path');
    expect(svg).not.toMatch(/<script|<foreignObject|<image|onload\s*=|onerror\s*=|xlink:href|<use\b/i);
    expect(svg).not.toMatch(/\bhref\s*=|url\(\s*https?:|data:/i);
  });
});
