import { readFileSync, readdirSync } from 'node:fs';
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

describe('BillOK Russian-only translations', () => {
  for (const namespace of namespaces) {
    it('Russian namespace ' + namespace + ' has complete, readable copy', () => {
      const russian = flatten(load('ru', namespace));
      expect(Object.keys(russian).length).toBeGreaterThan(0);
      for (const [key, text] of Object.entries(russian)) {
        expect(text.trim(), 'Empty: ' + namespace + '.' + key).not.toBe('');
        expect(text, 'Upstream brand: ' + namespace + '.' + key).not.toMatch(/ShareTab/iu);
        // ID is the agreed compact technical abbreviation; require its exact format.
        if (namespace === 'admin' && key === 'audit.actorIdPreview') {
          expect(text).toBe('ID: {value}');
          continue;
        }
        if (
          ![
            'brand.name',
            'login.emailPlaceholder',
            'register.emailPlaceholder',
            'login.passwordPlaceholder',
            'detail',
            'new.amountPlaceholder',
          ].includes(key)
        ) {
          expect(text, 'Untranslated: ' + namespace + '.' + key).toMatch(/[А-Яа-яЁё]/u);
        }
      }
    });
  }

  it('uses Author for the receipt role without renaming the payer or finalization organizer (Issue #19)', () => {
    const split = flatten(load('ru', 'split'));
    const role = Object.entries(split).find(([key]) => key.endsWith('.creator') || key === 'creator');
    expect(role?.[1]).toBe('Автор чека');
    expect(split['people.creatorAlwaysIncluded']).toContain('Автор чека');
    expect(split['people.creatorPayer']).toBe('Я — автор чека');
    expect(split['claim.finalizationOrganizerHint']).toContain('Только автор чека');
    expect(split['claim.finalizationOrganizerHint']).toContain('уполномоченный пользователь');
    expect(split['roles.payer']).toBe('Плательщик');
    expect(split['claim.finalizationOrganizerAppoint']).toBe('Предоставить право завершения');
    for (const namespace of namespaces) {
      for (const [key, text] of Object.entries(flatten(load('ru', namespace)))) {
        expect(text, namespace + '.' + key).not.toMatch(/создател|организатор/iu);
      }
    }
  });

  it('has no abandoned language catalogs', () => {
    const names = readdirSync(resolve(process.cwd(), 'messages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(names).toEqual(['ru']);
  });

  it('keeps Russian plural categories in invitation and counters', () => {
    for (const value of [load('ru', 'auth').invite, load('ru', 'dashboard')]) {
      const stringified = JSON.stringify(value);
      expect(stringified).toContain('few {');
      expect(stringified).toContain('many {');
    }
  });

  it('loads the Russian errors namespace for manual receipt errors', () => {
    const request = readFileSync(resolve(process.cwd(), 'src/i18n/request.ts'), 'utf8');
    expect(request).toContain('const errors = (await import(');
    expect(request).toContain('/errors.json');
    expect(request).toMatch(/\berrors,\s*\}/);
    expect(load('ru', 'errors').receiptNotProcessed as string).toMatch(/чек/iu);
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

  it('keeps payer and group transfer placeholders without obsolete currency notices', () => {
    const groups = load('ru', 'groups');
    const expenses = load('ru', 'expenses');
    const groupDetail = groups.detail as Record<string, string>;
    const expenseNew = expenses.new as Record<string, string>;
    expect(groupDetail.paidBy).toContain('{name}');
    expect(expenseNew).not.toHaveProperty('differentCurrencyNote');
    expect(expenseNew.rubOnlyLegacyGroup).toContain('{currency}');
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
    expect(claim.dishAllocationHeading).toMatch(/части блюд/);
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
