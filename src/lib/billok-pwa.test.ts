import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const manifestPath = resolve(process.cwd(), 'public/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  name: string;
  short_name: string;
  description: string;
  id: string;
  start_url: string;
  scope: string;
  lang: string;
  display: string;
  orientation: string;
  icons: { src: string; sizes: string; type: string }[];
};

describe('BillOK mobile PWA manifest', () => {
  it('has a stable install identity and mobile app branding', () => {
    expect(manifest.name).toBe('BillOK');
    expect(manifest.short_name).toBe('BillOK');
    expect(manifest.description).not.toMatch(/AI|OCR|сканировани/i);
    expect(manifest.id).toBe('/');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.lang).toBe('ru-RU');
  });

  it('opens standalone in portrait and references available icons', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.orientation).toBe('portrait-primary');
    expect(manifest.icons.length).toBeGreaterThan(0);

    for (const icon of manifest.icons) {
      expect(icon.src).toMatch(/^\/icons\//);
      expect(existsSync(resolve(process.cwd(), 'public', icon.src.slice(1)))).toBe(true);
    }
  });
});
