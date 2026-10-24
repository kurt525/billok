import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const namespaces = ['common', 'auth', 'dashboard', 'settings', 'splits', 'errors', 'groups', 'expenses'] as const;

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
          ![
            'brand.name',
            'login.emailPlaceholder',
            'register.emailPlaceholder',
            'login.passwordPlaceholder',
            'profile.venmoPlaceholder',
            'detail',
            'new.amountPlaceholder',
            'new.exchangeRatePlaceholder',
          ].includes(key)
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

  it('keeps the error detail placeholder available without adding unsafe text', () => {
    const errors = load('ru', 'errors');
    expect(errors.detail).toBe('{detail}');
    expect((errors.generic as Record<string, string>).unauthorized).toMatch(/Сеанс завершён/);
  });

  it('has unique Russian names for split states and human-readable rejection messages', () => {
    const splits = load('ru', 'splits');
    expect(splits.claiming).not.toBe(splits.finalized);
    const errors = load('ru', 'errors');
    expect(errors.joinNameTaken).toMatch(/имене[мни]/);
    expect(errors.serverBusy).toContain('BillOK');
  });

  it('includes correct plural branches for split counters', () => {
    const splits = load('ru', 'splits');
    for (const key of ['people', 'items']) {
      const template = String(splits[key]);
      expect(template).toContain('one {');
      expect(template).toContain('few {');
      expect(template).toContain('many {');
      expect(template).toContain('other {');
    }

    const plural = new Intl.PluralRules('ru');
    expect([1, 2, 5, 21, 22, 25].map((count) => plural.select(count))).toEqual([
      'one',
      'few',
      'many',
      'one',
      'few',
      'many',
    ]);
  });

  it('uses the Russian plural forms for group member and expense counters', () => {
    const groups = load('ru', 'groups');
    const list = groups.list as Record<string, string>;
    for (const name of ['memberCount', 'expenseCount']) {
      expect(list[name]).toContain('one {');
      expect(list[name]).toContain('few {');
      expect(list[name]).toContain('many {');
      expect(list[name]).toContain('other {');
    }
  });

  it('keeps payer, group transfer and currency placeholders when splitting expenses', () => {
    const groups = load('ru', 'groups');
    const expenses = load('ru', 'expenses');
    const groupDetail = groups.detail as Record<string, string>;
    const expenseNew = expenses.new as Record<string, string>;
    expect(groupDetail.paidBy).toContain('{name}');
    expect(expenseNew.differentCurrencyNote).toContain('{expenseCurrency}');
    expect(expenseNew.differentCurrencyNote).toContain('{groupCurrency}');
    const transfer = groups.transfer as Record<string, string>;
    expect(transfer.done).toContain('{name}');
  });

  it('does not expose the incomplete Russian language to end users', () => {
    const routing = readFileSync(resolve(process.cwd(), 'src/i18n/routing.ts'), 'utf8');
    expect(routing).not.toMatch(/locales\s*=\s*\[[^\]]*['"]ru['"]/);
  });
});
