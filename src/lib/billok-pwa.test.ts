import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
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

  it('offers an opt-in Push worker without intercepting receipt fetches or leaking credentials', () => {
    const worker = readFileSync(resolve(process.cwd(), 'public/billok-push-sw.js'), 'utf8');
    expect(worker).toContain("addEventListener('push'");
    expect(worker).toContain("addEventListener('notificationclick'");
    expect(worker).toContain('showNotification(');
    expect(worker).toContain('clients.openWindow');
    expect(worker).not.toContain("addEventListener('fetch'");
    expect(worker).not.toMatch(/personToken|payerSbpPhone|authorizationHeader/i);
  });

  it('shows a generic Android notification and opens only same-origin receipt links', async () => {
    const script = readFileSync(resolve(process.cwd(), 'public/billok-push-sw.js'), 'utf8');
    const handlers = new Map<string, (event: unknown) => void>();
    const shown: { title: string; body: string; data: { url: string } }[] = [];
    const opened: string[] = [];
    const waiting: Promise<unknown>[] = [];
    runInNewContext(script, {
      self: {
        location: { origin: 'https://billok.ru' },
        addEventListener: (name: string, callback: (event: unknown) => void) => handlers.set(name, callback),
        registration: {
          showNotification: async (title: string, options: { body: string; data: { url: string } }) => {
            shown.push({ title, body: options.body, data: options.data });
          },
        },
      },
      clients: {
        matchAll: async () => [],
        openWindow: async (url: string) => {
          opened.push(url);
        },
      },
      URL,
    });
    const push = handlers.get('push');
    expect(push).toBeDefined();
    push?.({
      data: { json: () => ({ url: '/split/receipt-7/claim', body: 'PRIVATE +79991234567', personToken: 'secret' }) },
      waitUntil: (result: Promise<unknown>) => {
        waiting.push(result);
      },
    });
    await Promise.all(waiting.splice(0));
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe('BillOK');
    expect(shown[0]?.body).toContain('Откройте чек');
    expect(shown[0]?.body).not.toContain('PRIVATE');
    expect(shown[0]?.body).not.toContain('+7999');
    expect(shown[0]?.data.url).toBe('/split/receipt-7/claim');
    let closed = false;
    const click = handlers.get('notificationclick');
    click?.({
      notification: {
        data: { url: 'https://attacker.example/internal' },
        close: () => {
          closed = true;
        },
      },
      waitUntil: (result: Promise<unknown>) => {
        waiting.push(result);
      },
    });
    await Promise.all(waiting.splice(0));
    expect(closed).toBe(true);
    expect(opened).toEqual(['https://billok.ru/']);
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
