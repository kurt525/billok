import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = (file: string) => readFileSync(resolve(root, file), 'utf8');

function tsxFiles(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [path] : [];
  });
}

describe('BillOK Russian-only error and notification audit', () => {
  it('rejects raw tRPC and browser exceptions on all user-facing TSX screens', () => {
    const files = [...tsxFiles('src/app'), ...tsxFiles('src/components')];
    expect(files.length).toBeGreaterThan(60);

    for (const file of files) {
      const ui = source(file);
      expect(ui, file).not.toMatch(/toast\.(?:error|warning)\(\s*(?:e|err|error)\.message\s*\)/);
      expect(ui, file).not.toMatch(/\{\s*[a-zA-Z]\w*\.error\.message\s*\}/);
      expect(ui, file).not.toMatch(/(?:error|err) instanceof Error \? (?:error|err)\.message/);
      expect(ui, file).not.toContain('res.statusText');
      expect(ui, file).not.toContain('toast.error(data?.error');
    }
  });

  it('uses Russian API error responses for administrator impersonation', () => {
    const api = source('src/app/api/admin/impersonate/route.ts');
    for (const english of ['Forbidden', 'userId is required', 'Cannot impersonate yourself', 'User not found']) {
      expect(api).not.toContain("error: '" + english + "'");
    }
    expect(api).toContain("error: 'Доступ запрещён'");
    expect(api).toContain("error: 'Пользователь не найден'");
  });

  it('keeps Russian-only locale, translation messages and transactional email', () => {
    const routing = source('src/i18n/routing.ts');
    expect(routing).toContain("locales = ['ru']");
    expect(routing).toContain('localeDetection: false');

    for (const filename of readdirSync(resolve(root, 'messages/ru')).filter((f) => f.endsWith('.json'))) {
      expect(source('messages/ru/' + filename), filename).not.toMatch(/ShareTab/i);
    }

    const email = source('src/server/lib/magic-link-email.ts');
    expect(email).toContain('Ссылка для входа в BillOK');
    expect(email).not.toMatch(/Sign in to ShareTab|Click here to sign in/i);
    const adminEmail = source('src/server/trpc/routers/admin.ts');
    expect(adminEmail).toContain("subject: 'Проверка электронной почты BillOK'");
  });
});
