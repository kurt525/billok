import { describe, expect, it } from 'vitest';
import { createLatestActiveMountRegistry } from './latest-active-mount';

describe('one active payer review across retained route trees', () => {
  it('keeps only the newest mounted review active and promotes the previous on unmount', () => {
    const registry = createLatestActiveMountRegistry();
    const oldId = Symbol('old route');
    const newId = Symbol('new route');
    const notifications: string[] = [];
    const stopOld = registry.subscribe('receipt:payer', oldId, () => notifications.push('old'));
    expect(registry.isActive('receipt:payer', oldId)).toBe(true);

    const stopNew = registry.subscribe('receipt:payer', newId, () => notifications.push('new'));
    expect(registry.isActive('receipt:payer', oldId)).toBe(false);
    expect(registry.isActive('receipt:payer', newId)).toBe(true);
    expect(notifications).toContain('old');
    expect(notifications).toContain('new');

    stopNew();
    expect(registry.isActive('receipt:payer', oldId)).toBe(true);
    stopOld();
    expect(registry.isActive('receipt:payer', oldId)).toBe(false);
  });

  it('keeps different payer identities separate while cleaning up old owners', () => {
    const registry = createLatestActiveMountRegistry();
    const boris = Symbol('boris');
    const replacement = Symbol('replacement');
    const anna = Symbol('anna');
    const stopBoris = registry.subscribe('receipt:boris', boris, () => {});
    const stopReplacement = registry.subscribe('receipt:boris', replacement, () => {});
    const stopAnna = registry.subscribe('receipt:anna', anna, () => {});
    expect(registry.isActive('receipt:boris', replacement)).toBe(true);
    expect(registry.isActive('receipt:anna', anna)).toBe(true);
    stopBoris();
    expect(registry.isActive('receipt:boris', replacement)).toBe(true);
    stopReplacement();
    stopAnna();
    expect(registry.isActive('receipt:boris', replacement)).toBe(false);
    expect(registry.isActive('receipt:anna', anna)).toBe(false);
  });
});
