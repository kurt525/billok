import { describe, expect, it } from 'vitest';
import { normalizeSecurityActorUuid, securityActorPreview } from './security-actor-uuid';

describe('TASK-BILLOK-011: exact actor UUID', () => {
  const id = 'abcdef12-1234-4abc-8def-123456789abc';
  it('normalizes only full UUID and surrounding whitespace', () => {
    expect(normalizeSecurityActorUuid('  ' + id.toUpperCase() + '  ')).toBe(id);
    expect(normalizeSecurityActorUuid(id)).toBe(id);
    for (const value of [
      '',
      id.slice(0, 8),
      id + 'x',
      'Гость',
      id.replace(/-/gu, ''),
      'abc@example.ru',
      id.replace('4abc', '0abc'),
      id.replace('8def', '0def'),
    ]) {
      expect(normalizeSecurityActorUuid(value)).toBeNull();
    }
  });
  it('shortens only display, preserving ambiguous prefixes', () => {
    expect(securityActorPreview(id)).toBe('abcdef12…');
    expect(securityActorPreview('abcdef12-4321-4abc-8def-123456789abc')).toBe('abcdef12…');
    expect(securityActorPreview('legacy')).toBe('legacy');
  });
});
