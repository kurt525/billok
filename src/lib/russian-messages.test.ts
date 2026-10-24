import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const namespaces = ['common', 'auth', 'dashboard'] as const;

function load(locale: string, namespace: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(process.cwd(), `messages/${locale}/${namespace}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

function flatten(input: Record<string, unknown>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      result[path] = value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flatten(value as Record<string, unknown>, path));
    } else {
      throw new Error(`Invalid translation at ${path}`);
    }
  }
  return result;
}

function params(value: string): string[] {
  return [...value.matchAll(/\{([a-z][a-zA-Z0-9_]*)\b/g)].map((match) => match[1]!).sort();
}

function richTags(value: string): string[] {
  return [...value.matchAll(/<\/?([a-z][a-zA-Z0-9_]*)>/g)].map((match) => match[1]!).sort();
}

describe('Russian translations (incremental staging)', () => {
  for (const namespace of namespaces) {
    it(`${namespace} has every source key and matching ICU arguments`, () => {
      const english = flatten(load('en', namespace));
      const russian = flatten(load('ru', namespace));

      expect(Object.keys(russian).sort()).toEqual(Object.keys(english).sort());
      for (const key of Object.keys(english)) {
        expect(russian[key]!.trim(), `Empty: ${namespace}.${key}`).not.toBe('');
        expect(params(russian[key]!), `Variables: ${namespace}.${key}`).toEqual(params(english[key]!));
        expect(richTags(russian[key]!), `Rich text: ${namespace}.${key}`).toEqual(richTags(english[key]!));
        if (
          !['brand.name', 'login.emailPlaceholder', 'register.emailPlaceholder', 'login.passwordPlaceholder'].includes(
            key,
          )
        ) {
          expect(russian[key], `Untranslated: ${namespace}.${key}`).toMatch(/[А-Яа-яЁё]/);
        }
      }
    });
  }

  it('keeps Russian plural categories in invitation and counters', () => {
    for (const value of [load('ru', 'auth').invite, load('ru', 'dashboard')]) {
      const stringified = JSON.stringify(value);
      expect(stringified).toContain('few {');
      expect(stringified).toContain('many {');
    }
  });

  it('does not expose the incomplete Russian language to end users', () => {
    const routing = readFileSync(resolve(process.cwd(), 'src/i18n/routing.ts'), 'utf8');
    expect(routing).not.toMatch(/locales\s*=\s*\[[^\]]*['"]ru['"]/);
  });
});
