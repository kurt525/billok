import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reconcileSbpCatalog } from './sbp-catalog-sync.mjs';

const baseline = JSON.parse(readFileSync(new URL('../../src/lib/sbp-bank-catalog.json', import.meta.url)));
function fixture() {
  const current = structuredClone(baseline);
  const source = {
    // Advance beyond the checked-in snapshot, not a hard-coded 2026 date:
    // daily upstream updates must not break CI as the catalog gets newer.
    updatedAt: new Date(Date.parse(current.sourceUpdatedAt) + 60000).toISOString(),
    banks: current.banks.map((bank) => ({ id: bank.nspkId, name: bank.sourceName ?? bank.name })),
  };
  return { current, source };
}

describe('daily SBP catalog sync', () => {
  it('does not create a commit for a date-only change', () => {
    const { current, source } = fixture();
    const result = reconcileSbpCatalog(current, source);
    assert.equal(result.changed, false);
    assert.equal(result.catalog.sourceUpdatedAt, current.sourceUpdatedAt);
  });

  it('detects additions but preserves original account bank IDs', () => {
    const { current, source } = fixture();
    source.banks.push({ id: '999999999991', name: 'Новый банк' });
    const result = reconcileSbpCatalog(current, source);
    assert.equal(result.stats.added, 1);
    assert.deepEqual(result.catalog.banks.at(-1), {
      id: '999999999991',
      name: 'Новый банк',
      nspkId: '999999999991',
      icon: null,
    });
    assert.equal(result.catalog.banks[0].id, 'sberbank');
    assert.equal(result.catalog.banks[0].name, 'СберБанк');
  });

  it('updates a changed official name without deleting the stable bank ID', () => {
    const { current, source } = fixture();
    source.banks.find((bank) => bank.id === '100000000004').name = 'Т Банк — новое название';
    const result = reconcileSbpCatalog(current, source);
    assert.equal(result.stats.renamed, 1);
    const bank = result.catalog.banks.find((bank) => bank.id === 'tbank');
    assert.equal(bank.nspkId, '100000000004');
    assert.equal(bank.name, 'Т Банк — новое название');
  });

  it('retires disappeared banks but retains existing profile ID and logo', () => {
    const { current, source } = fixture();
    source.banks = source.banks.filter((bank) => bank.id !== '100000000004');
    const result = reconcileSbpCatalog(current, source);
    assert.equal(result.stats.removed, 1);
    const bank = result.catalog.banks.find((bank) => bank.id === 'tbank');
    assert.equal(bank.active, false);
    assert.equal(bank.icon, '/banks/tbank.svg');
    source.banks.push({ id: '100000000004', name: 'Т-Банк' });
    const restored = reconcileSbpCatalog(result.catalog, source);
    assert.equal(restored.catalog.banks.find((bank) => bank.id === 'tbank').active, undefined);
  });

  it('rejects a suspicious mass removal or duplicate upstream ID', () => {
    const { current, source } = fixture();
    source.banks = source.banks.slice(0, 101);
    assert.throws(() => reconcileSbpCatalog(current, source), /Excessive upstream removals/);
    source.banks = fixture().source.banks;
    source.banks.push(source.banks[0]);
    assert.throws(() => reconcileSbpCatalog(current, source), /Duplicate upstream bank ID/);
  });

  it('remains valid after future daily registry refreshes, without date-only commits', () => {
    const { current, source } = fixture();
    current.sourceUpdatedAt = '2032-08-15T09:00:00.000Z';
    source.updatedAt = new Date(Date.parse(current.sourceUpdatedAt) + 60000).toISOString();
    const result = reconcileSbpCatalog(current, source);
    assert.equal(result.changed, false);
    assert.equal(result.catalog.sourceUpdatedAt, current.sourceUpdatedAt);

    // A real content change on a later day still produces a reviewable diff.
    source.banks.push({ id: '999999999992', name: 'Банк для будущего обновления' });
    const changed = reconcileSbpCatalog(current, source);
    assert.equal(changed.changed, true);
    assert.equal(changed.stats.added, 1);
    assert.equal(changed.catalog.sourceUpdatedAt, source.updatedAt);
  });

  it('rejects unsafe or stale data, without modifying the local catalog', () => {
    const { current, source } = fixture();
    source.updatedAt = '2020-01-01T00:00:00Z';
    assert.throws(() => reconcileSbpCatalog(current, source), /older/);
    source.updatedAt = fixture().source.updatedAt;
    source.banks[0].name = '<script>alert(1)</script>';
    assert.throws(() => reconcileSbpCatalog(current, source), /Invalid upstream bank display name/);
    assert.equal(current.banks[0].name, 'СберБанк');
  });
});
