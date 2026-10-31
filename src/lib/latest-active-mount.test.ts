import { describe, expect, it } from 'vitest';
import { createLatestActiveMountRegistry, getDocumentActiveMountRegistry } from './latest-active-mount';

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

describe('shared payer review ownership between independently loaded client modules', () => {
  it('uses one owner per payer across copies of the same document', () => {
    const currentDocument = {};
    const firstModule = getDocumentActiveMountRegistry(currentDocument);
    const secondModule = getDocumentActiveMountRegistry(currentDocument);
    expect(firstModule).toBe(secondModule);
    const previous = Symbol('old route');
    const next = Symbol('new route');
    const stopPrevious = firstModule.subscribe('receipt:payer', previous, () => {});
    const stopNext = secondModule.subscribe('receipt:payer', next, () => {});
    expect(firstModule.isActive('receipt:payer', previous)).toBe(false);
    expect(secondModule.isActive('receipt:payer', next)).toBe(true);
    stopNext();
    expect(firstModule.isActive('receipt:payer', previous)).toBe(true);
    stopPrevious();
  });

  it('keeps the registry isolated per browser document', () => {
    const first = getDocumentActiveMountRegistry({});
    const second = getDocumentActiveMountRegistry({});
    expect(first).not.toBe(second);
    const id = Symbol('private payer');
    const dispose = first.subscribe('receipt:payer', id, () => {});
    expect(second.isActive('receipt:payer', id)).toBe(false);
    dispose();
  });
});
