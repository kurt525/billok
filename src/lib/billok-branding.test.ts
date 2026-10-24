import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('BillOK brand foundation', () => {
  test('mobile, sidebar and guest check headers use the BillOK name', () => {
    for (const file of [
      'src/components/layout/mobile-header.tsx',
      'src/components/layout/sidebar.tsx',
      'src/app/[locale]/split/layout.tsx',
    ]) {
      expect(source(file)).toContain('BillOK');
      expect(source(file)).not.toContain('ShareTab');
    }
  });

  test('mail sender defaults and templates are branded BillOK', () => {
    expect(source('.env.example')).toContain('BillOK <noreply@billok.ru>');
    for (const file of [
      'src/server/auth.ts',
      'src/server/trpc/routers/admin.ts',
      'src/server/lib/auth-health-poller.ts',
    ]) {
      expect(source(file)).toContain('BillOK <noreply@billok.ru>');
      expect(source(file)).not.toContain('ShareTab <noreply@sharetab.local>');
      expect(source(file)).not.toContain('ShareTab Test Email');
      expect(source(file)).not.toContain('[ShareTab]');
    }
  });

  test('PWA and app icons share the same SVG ruble-receipt design', () => {
    const svg = source('public/icons/icon.svg');
    expect(svg).toBe(source('src/app/icon.svg'));
    expect(svg).toContain('BillOK brand');
    expect(svg).not.toContain('Dollar');
    expect(svg).toContain('viewBox="0 0 512 512"');
  });

  test('binary icons have the expected pixel dimensions', () => {
    for (const [path, width] of [
      ['public/icons/icon-192.png', 192],
      ['public/icons/icon-512.png', 512],
      ['src/app/favicon.png', 32],
    ] as const) {
      const file = readFileSync(resolve(process.cwd(), path));
      expect(file.subarray(1, 4).toString('ascii')).toBe('PNG');
      expect(file.readUInt32BE(16)).toBe(width);
      expect(file.readUInt32BE(20)).toBe(width);
    }
  });
});
