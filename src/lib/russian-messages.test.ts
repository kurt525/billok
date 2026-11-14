import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const namespaces = [
  'common',
  'auth',
  'dashboard',
  'settings',
  'splits',
  'errors',
  'groups',
  'expenses',
  'split',
  'admin',
] as const;

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

describe('BillOK Russian-only translations', () => {
  for (const namespace of namespaces) {
    it(`${namespace} has every source key and matching ICU arguments`, () => {
      const english = flatten(load('en', namespace));
      const russian = flatten(load('ru', namespace));

      // English is a historical compatibility floor, not a supported locale.
      expect(Object.keys(russian)).toEqual(expect.arrayContaining(Object.keys(english)));
      for (const key of Object.keys(russian)) {
        expect(russian[key]!.trim(), `Empty: ${namespace}.${key}`).not.toBe('');
        if (english[key]) {
          expect(params(russian[key]!), `Variables: ${namespace}.${key}`).toEqual(params(english[key]!));
          expect(richTags(russian[key]!), `Rich text: ${namespace}.${key}`).toEqual(richTags(english[key]!));
        }
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

  it('loads the Russian errors namespace for client-side OCR failures', () => {
    const request = readFileSync(resolve(process.cwd(), 'src/i18n/request.ts'), 'utf8');
    expect(request).toContain('const errors = (await import(');
    expect(request).toContain('/errors.json');
    expect(request).toMatch(/\berrors,\s*\}/);
    expect(load('ru', 'errors').receiptProcessingFailed as string).toMatch(/Не удалось обработать чек/);
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

  it('retains identity and personal-link security warnings for guests', () => {
    const claim = load('ru', 'split').claim as Record<string, string>;
    for (const key of ['personalLinkHint', 'personalLinkCopied', 'personalLinkShared']) {
      expect(claim[key]).toMatch(/ссылк/);
      expect(claim[key]).toMatch(/от вашего имени/);
    }
    expect(claim.personalLinkOfferBody).toContain('{name}');
    expect(claim.personalLinkOfferReplaces).toContain('{current}');
    expect(claim.personalLinkOfferReplaces).toContain('{name}');
    expect(claim.personalLinkInvalid).toMatch(/не действует/);
  });

  it('preserves guest participants, shared item claims and payer labels', () => {
    const split = load('ru', 'split');
    const claim = split.claim as Record<string, string>;
    const result = split.result as Record<string, string>;
    expect(claim.tapToClaim).toMatch(/позици/);
    expect(claim.alreadyClaimed).toMatch(/выбрано/);
    expect(claim.claimConflict).toContain('{names}');
    expect(claim.claimConflict).toContain('many {');
    expect(result.paidBy).toBe('Оплатил <name>{payer}</name>');
    expect(result.shareText).toContain('{total}');
  });

  it('preserves administrator labels and deletion messages', () => {
    const admin = load('ru', 'admin');
    const users = admin.users as Record<string, string>;
    const registration = admin.registration as Record<string, string>;
    expect(users.deleteDescription).toContain('{name}');
    expect(users.deleteDescription).toMatch(/безвозвратно/);
    expect(registration.inviteOnly).toMatch(/приглашению/);
    expect(registration.statusUsedBy).toContain('{name}');
  });

  it('preserves audit records and email notification arguments', () => {
    const admin = load('ru', 'admin');
    const tools = admin.tools as Record<string, string>;
    const audit = admin.audit as Record<string, string>;
    expect(tools.emailSentTo).toContain('{email}');
    expect(tools.exportFailed).toContain('{error}');
    expect(audit.actionTestEmail).toMatch(/письмо/);
  });

  it('requires every Russian namespace to exist before activating the Russian-only app', () => {
    const english = [
      'common',
      'auth',
      'dashboard',
      'settings',
      'splits',
      'errors',
      'groups',
      'expenses',
      'split',
      'admin',
    ];
    expect([...namespaces].sort()).toEqual([...english].sort());
    const routing = readFileSync(resolve(process.cwd(), 'src/i18n/routing.ts'), 'utf8');
    expect(routing).toContain("export const locales = ['ru'] as const");
    expect(routing).toContain("defaultLocale: Locale = 'ru'");
  });
});
