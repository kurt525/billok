import { describe, expect, test } from 'vitest';
import { systemInviteCreateApprovalTarget } from './system-invite-approval-target';

describe('Issue 6.12.4.3: an invite approval binds the exact 7-day creation intent', () => {
  test('unlabeled is a unique canonical target, not a label collision', () => {
    expect(systemInviteCreateApprovalTarget()).toBe('invite:v1:7:none');
    expect(systemInviteCreateApprovalTarget('   ')).toBe(systemInviteCreateApprovalTarget());
    expect(systemInviteCreateApprovalTarget('none')).not.toBe(systemInviteCreateApprovalTarget());
    expect(systemInviteCreateApprovalTarget('')).not.toBe(systemInviteCreateApprovalTarget('none'));
  });
  test('normalizes display whitespace consistently for UI/server, without merging different labels', () => {
    expect(systemInviteCreateApprovalTarget(' Для Анны ')).toBe(systemInviteCreateApprovalTarget('Для Анны'));
    expect(systemInviteCreateApprovalTarget('Для Анны')).not.toBe(systemInviteCreateApprovalTarget('Для Ивана'));
    expect(systemInviteCreateApprovalTarget('x'.repeat(100)).length).toBeLessThanOrEqual(128);
    expect(() => systemInviteCreateApprovalTarget('x'.repeat(101))).toThrow();
  });
});
