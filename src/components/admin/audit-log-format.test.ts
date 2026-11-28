import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AdminAction } from '@/generated/prisma/enums';
import messages from '../../../messages/ru/admin.json';
import {
  actionPresentation,
  auditActions,
  auditDetails,
  auditTime,
  createAuditDateFormatter,
  groupAuditEntries,
  securityActions,
} from './audit-log-format';

const t = (key: keyof typeof messages.audit, values?: Record<string, string | number>) =>
  messages.audit[key].replace(/\{(\w+)\}/gu, (match, name: string) => String(values?.[name] ?? match));
const dates = createAuditDateFormatter('ru-RU', 'Europe/Moscow');

function sources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [readFileSync(path, 'utf8')] : [];
  });
}

describe('TASK-BILLOK-010 — локализация журнала', () => {
  it('covers exactly every AdminAction with a readable Russian label', () => {
    expect(Object.keys(auditActions).sort()).toEqual(Object.values(AdminAction).sort());
    for (const action of Object.values(AdminAction)) {
      const label = t(actionPresentation(action).key);
      expect(label).toMatch(/[А-Яа-яЁё]/u);
      expect(label).not.toContain(action);
    }
  });

  it('covers every literal security producer and every admin mutation path', () => {
    const literalActions = ['src/app/api', 'src/server/lib', 'src/server/trpc']
      .flatMap(sources)
      .flatMap((source) =>
        [...source.matchAll(/recordOwnerSecurityEvent\(\{[^}]*?\baction:\s*'([^']+)'/gu)].map((match) => match[1]!),
      );
    expect(new Set(literalActions).size).toBeGreaterThanOrEqual(19);
    const router = readFileSync('src/server/trpc/routers/admin.ts', 'utf8');
    const mutationPaths = router.split(/(?=^  \w+: \w+Procedure)/mu).flatMap((block) => {
      const name = block.match(/^  (\w+): \w+Procedure/mu)?.[1];
      return name && /\.mutation\(/u.test(block) ? ['admin.' + name] : [];
    });
    expect(mutationPaths).toContain('admin.createSystemInvite');
    expect(mutationPaths).toContain('admin.cleanupUnusedReceipts');
    for (const action of [...literalActions, ...mutationPaths]) {
      expect(Object.hasOwn(securityActions, action), action).toBe(true);
    }
    for (const action of Object.keys(securityActions)) {
      expect(t(actionPresentation(action, true).key)).toMatch(/[А-Яа-яЁё]/u);
    }
  });

  it('does not render unknown action values, including object prototype keys', () => {
    for (const action of ['UNKNOWN_ACTION', 'constructor', '__proto__', 'toString']) {
      expect(t(actionPresentation(action).key)).toBe('Неизвестное событие');
      expect(t(actionPresentation(action, true).key)).toBe('Неизвестное событие');
      expect(auditDetails(action, { name: 'unknown', token: 'secret' }, t, dates)).toEqual([]);
    }
  });
});

describe('TASK-BILLOK-010 — подробности и время', () => {
  it('uses the saved expiry and label, never the invitation code or arbitrary fields', () => {
    const metadata = {
      label: 'Приглашение для теста',
      expiresAt: '2026-12-05T07:15:32.000Z',
      code: 'bearer-code-for-test',
      token: 'secret',
      error: 'internal error',
      currentStatus: 'revoked',
    };
    expect(auditDetails('INVITE_CREATED', metadata, t, dates)).toEqual([
      'Примечание: Приглашение для теста',
      'Действует до: 05.12.2026, 10:15:32 (срок при создании)',
    ]);
    expect(auditDetails('INVITE_REVOKED', { revokedAt: '2026-11-28T07:01:02.000Z' }, t, dates)).toEqual([
      'Отозвано: 28.11.2026, 10:01:02',
    ]);
  });

  it('uses local calendar and seconds consistently across midnight and time zones', () => {
    const timestamp = '2026-11-28T22:15:32.000Z';
    expect(auditTime(timestamp, dates)).toEqual({ text: '01:15:32', iso: timestamp });
    expect(auditDetails('INVITE_CREATED', { expiresAt: timestamp }, t, dates)).toEqual([
      'Действует до: 29.11.2026, 01:15:32 (срок при создании)',
    ]);
    const utc = createAuditDateFormatter('ru-RU', 'UTC');
    expect(auditDetails('INVITE_CREATED', { expiresAt: timestamp }, t, utc)).toEqual([
      'Действует до: 28.11.2026, 22:15:32 (срок при создании)',
    ]);
    const winter = createAuditDateFormatter('ru-RU', 'Europe/Amsterdam');
    expect(auditTime('2026-10-25T00:30:00.000Z', winter)?.text).toBe('02:30:00');
    expect(auditTime('2026-10-25T01:30:00.000Z', winter)?.text).toBe('02:30:00');
    expect(auditTime('2026-10-25T00:30:00.000Z', winter)?.iso).not.toBe(
      auditTime('2026-10-25T01:30:00.000Z', winter)?.iso,
    );
  });

  it('never invents missing or invalid dates or empty details', () => {
    for (const value of [
      null,
      {},
      [],
      'string',
      { expiresAt: 'tomorrow' },
      { expiresAt: '2026-02-31T00:00:00.000Z' },
      { label: ' ' },
    ]) {
      expect(auditDetails('INVITE_CREATED', value, t, dates)).toEqual([]);
    }
    expect(auditTime('invalid', dates)).toBeNull();
    expect(auditTime(new Date(NaN), dates)).toBeNull();
  });

  it('combines multiple pages into one date group, deduplicating only by ID', () => {
    const a = { id: 'a', createdAt: '2026-11-28T22:15:32.000Z' };
    const b = { id: 'b', createdAt: a.createdAt };
    const c = { id: 'c', createdAt: '2026-11-28T20:59:59.000Z' };
    const groups = groupAuditEntries([a, b, b, c], dates, 'Дата не определена');
    expect(groups.map((group) => group.items.map((row) => row.id))).toEqual([['a', 'b'], ['c']]);
    expect(groups[0]?.date).toContain('29 ноября');
    expect(groups[1]?.date).toContain('28 ноября');
  });

  it('localizes known metadata without disclosing arbitrary strings or credentials', () => {
    expect(auditDetails('REGISTRATION_MODE_CHANGED', { mode: 'closed' }, t, dates)).toEqual(['Регистрация закрыта']);
    expect(auditDetails('REGISTRATION_MODE_CHANGED', { mode: 'invite-only' }, t, dates)).toEqual([
      'Регистрация только по приглашениям',
    ]);
    expect(auditDetails('REGISTRATION_MODE_CHANGED', { mode: 'untrusted' }, t, dates)).toEqual([]);
    expect(
      auditDetails(
        'TEST_EMAIL_SENT',
        { to: 'qa@mail.ru', durationMs: 120, success: false, error: 'smtp secret', code: 'raw-secret' },
        t,
        dates,
      ),
    ).toEqual(['Получатель: qa@mail.ru', 'Длительность: 120 мс', 'Операция завершилась ошибкой']);
    expect(
      auditDetails(
        'OWNER_PASSKEY_APPROVAL_VERIFIED',
        { action: 'RENAME', signerCredentialRowId: 'private-id', approvalToken: 'secret', expiresInSeconds: 30 },
        t,
        dates,
      ),
    ).toEqual(['Операция: Переименование ключа доступа владельца', 'Срок подтверждения: 30 с']);
    expect(
      auditDetails('OWNER_PASSKEY_REVOKED', { activeRemaining: 2, previousSessionsRevoked: true }, t, dates),
    ).toEqual(['Действующих ключей: 2', 'Прежние сеансы завершены']);
    expect(auditDetails('EXPIRED_SPLITS_CLEANED', { deletedCount: 0 }, t, dates)).toEqual(['Записей: 0']);
    expect(auditDetails('EXPIRED_SPLITS_CLEANED', { deletedCount: 'secret' }, t, dates)).toEqual([]);
    expect(auditDetails('ANNOUNCEMENT_SET', { message: null }, t, dates)).toEqual(['Объявление удалено']);
    expect(auditDetails('ANNOUNCEMENT_SET', { message: 'А'.repeat(100) }, t, dates)).toEqual([
      'Объявление: ' + 'А'.repeat(50) + '…',
    ]);
  });
});
