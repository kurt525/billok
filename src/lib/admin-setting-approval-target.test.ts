import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { registrationModeApprovalTarget, announcementApprovalTarget } from './admin-setting-approval-target';

describe('Issue 6.12.4.4: exact value-bound owner setting approval targets', () => {
  test('registration modes have independent, unambiguous targets', () => {
    const values = ['open', 'invite-only', 'closed'] as const;
    const targets = values.map(registrationModeApprovalTarget);
    expect(new Set(targets).size).toBe(3);
    expect(targets).toEqual([
      'registration-mode:v1:open',
      'registration-mode:v1:invite-only',
      'registration-mode:v1:closed',
    ]);
    expect(targets.every((id) => id.length <= 128)).toBe(true);
  });

  test('an announcement binds all 500 characters without exposing text in the grant', async () => {
    const message = 'Только русский 🛡️ '.repeat(29).slice(0, 490);
    const target = await announcementApprovalTarget(message);
    const expected = createHash('sha256')
      .update('billok:admin-announcement:v1:' + message.trim())
      .digest('hex');
    expect(target).toBe('announcement:v1:' + expected);
    expect(target.length).toBeLessThan(128);
    expect(target).not.toContain('Только');
    expect(await announcementApprovalTarget(message + '!')).not.toBe(target);
  });

  test('trimmed message matches server persistence; clearing is a distinct action target', async () => {
    expect(await announcementApprovalTarget('  Привет  ')).toBe(await announcementApprovalTarget('Привет'));
    expect(await announcementApprovalTarget()).toBe(await announcementApprovalTarget('  '));
    expect(await announcementApprovalTarget('  ')).not.toBe(await announcementApprovalTarget('Привет'));
    expect(await announcementApprovalTarget('Регистрация закрыта')).not.toBe(registrationModeApprovalTarget('closed'));
  });
});
