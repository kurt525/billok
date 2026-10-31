import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLatestActiveMountRegistry, getDocumentActiveMountRegistry } from './latest-active-mount';

describe('payer review hydration safety', () => {
  it('registers the private card only after the component commits', () => {
    const component = readFileSync(join(process.cwd(), 'src/components/guest-payer-payment-review.tsx'), 'utf8');
    expect(component).not.toContain('useSyncExternalStore');
    expect(component).toContain('const [isActiveReview, setIsActiveReview] = useState(false)');
    expect(component).toContain('activePayerReviews.subscribe(token, mountId, onOwnershipChanged)');
    expect(component).toContain('mounted = false;');
    expect(component).toContain('unsubscribe();');
  });
});

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

  it('prevents a retained payer identity from showing a second review for the same receipt', () => {
    const registry = createLatestActiveMountRegistry();
    const olderIdentity = Symbol('previous payer identity');
    const latestIdentity = Symbol('current payer identity');
    // The owner key is the receipt token, never the person ID or personal token.
    const receiptToken = 'one-receipt-token';
    const stopPrevious = registry.subscribe(receiptToken, olderIdentity, () => {});
    const stopLatest = registry.subscribe(receiptToken, latestIdentity, () => {});
    expect(registry.isActive(receiptToken, olderIdentity)).toBe(false);
    expect(registry.isActive(receiptToken, latestIdentity)).toBe(true);
    stopPrevious();
    expect(registry.isActive(receiptToken, latestIdentity)).toBe(true);
    stopLatest();
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
