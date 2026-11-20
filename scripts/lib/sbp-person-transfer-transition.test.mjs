import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditSbpPersonTransfers, OFFICIAL_PERSON_TRANSFER_URL } from './sbp-person-transfer-audit.mjs';
import {
  CURRENT_C2B_SOURCE_SYSTEM,
  REVIEW_C2C_SOURCE_SYSTEM,
  planSbpPersonTransition,
} from './sbp-person-transfer-transition.mjs';
import { reconcileSbpCatalog } from './sbp-catalog-sync.mjs';

const catalog = JSON.parse(readFileSync(new URL('../../src/lib/sbp-bank-catalog.json', import.meta.url)));
const at = new Date('2026-11-09T12:00:00.000Z');

function official(
  banks = catalog.banks.map((bank) => ({
    name: bank.sourceName ?? bank.name,
    nspkId: bank.nspkId,
  })),
) {
  return {
    source: OFFICIAL_PERSON_TRANSFER_URL,
    fetchedAt: at.toISOString(),
    type: 'person',
    labels: ['person-transfer'],
    banks,
  };
}

describe('BillOK 4.3.2.3.1: fail-closed C2C catalog transition plan', () => {
  it('preserves all stable legacy IDs, strips unapproved logos and never publishes', () => {
    const original = JSON.stringify(catalog);
    const result = planSbpPersonTransition(catalog, official(), at);
    assert.deepEqual(result.blockers, []);
    assert.equal(result.candidate.sourceSystem, REVIEW_C2C_SOURCE_SYSTEM);
    assert.equal(result.candidate.source, OFFICIAL_PERSON_TRANSFER_URL);
    assert.equal(result.audit.matchedTotal, catalog.banks.length);
    assert.equal(result.candidate.banks.length, catalog.banks.length);
    assert.deepEqual(
      result.candidate.banks.map((bank) => bank.id),
      catalog.banks.map((bank) => bank.id),
    );
    assert.ok(result.candidate.banks.every((bank) => bank.icon === null));
    assert.equal(result.canPublishAutomatically, false);
    assert.equal(result.requiresExplicitOwnerApproval, true);
    assert.equal(result.officialSourceProvenanceExternallyVerified, false);
    assert.equal(JSON.stringify(catalog), original);
  });

  it('separates 204 official and 195 local as 194 matched, 10 added, one retired', () => {
    const banks = official().banks.slice(1);
    for (let i = 0; i < 10; i++) {
      banks.push({
        name: 'Искусственный официальный банк ' + i,
        nspkId: String(900000000000 + i),
      });
    }
    assert.equal(banks.length, 204);
    const result = planSbpPersonTransition(catalog, official(banks), at);
    assert.equal(result.audit.matchedTotal, 194);
    assert.equal(result.audit.unmatchedOfficialTotal, 10);
    assert.equal(result.audit.unmatchedLocalTotal, 1);
    assert.equal(result.candidate.banks.length, 205);
    assert.equal(result.candidate.banks.filter((bank) => bank.active !== false).length, 204);
    assert.equal(result.candidate.banks[0].id, 'sberbank');
    assert.equal(result.candidate.banks[0].active, false);
    assert.equal(result.candidate.banks.at(-1).icon, null);
    assert.equal(result.canPublishAutomatically, false);
    // Synthetic test data does not represent actual NSPK member banks.
  });

  it('refuses a name-only match until official member ID is verified', () => {
    const banks = official().banks.map((bank) => (bank.nspkId === '100000000004' ? { name: 'Т-Банк' } : bank));
    const result = planSbpPersonTransition(catalog, official(banks), at);
    assert.ok(result.blockers.includes('NAME_ONLY_IDENTITIES_REQUIRE_VERIFICATION'));
    assert.equal(result.candidate, null);
  });

  it('refuses a new official bank with unverified member ID', () => {
    const banks = official().banks.slice(1);
    banks.push({ name: 'Неизвестная официальная запись без member ID' });
    const result = planSbpPersonTransition(catalog, official(banks), at);
    assert.ok(result.blockers.includes('OFFICIAL_MEMBER_IDS_UNAVAILABLE'));
    assert.equal(result.candidate, null);
    assert.equal(result.canPublishAutomatically, false);
  });

  it('refuses ambiguous identities and duplicate internal IDs', () => {
    const changed = structuredClone(catalog);
    changed.banks[1].sourceName = changed.banks[0].name;
    const banks = official().banks.map((bank) => (bank.nspkId === '100000000111' ? { name: 'СберБанк' } : bank));
    const result = planSbpPersonTransition(changed, official(banks), at);
    assert.ok(result.blockers.includes('AMBIGUOUS_IDENTITIES'));
    assert.equal(result.candidate, null);
  });

  it('refuses QR/C2B snapshots, wrong current registry and stale data', () => {
    assert.throws(
      () => planSbpPersonTransition(catalog, { ...official(), labels: ['person-transfer-qr'] }, at),
      /Wrong official source/,
    );
    assert.throws(
      () => planSbpPersonTransition({ ...catalog, sourceSystem: REVIEW_C2C_SOURCE_SYSTEM }, official(), at),
      /expected legacy/,
    );
    assert.throws(
      () => planSbpPersonTransition(catalog, { ...official(), fetchedAt: '2026-06-01T12:00:00Z' }, at),
      /stale/,
    );
  });

  it('blocks multiple official banks with an indistinguishable display name', () => {
    const entries = official().banks.map((bank) => ({ ...bank }));
    entries[0].name = entries[1].name;
    const result = planSbpPersonTransition(catalog, official(entries), at);
    assert.ok(result.blockers.includes('DUPLICATED_OFFICIAL_NAMES'));
    assert.equal(result.candidate, null);
  });

  it('prevents the legacy eav93 C2B updater from reactivating a C2C-only bank', () => {
    const preview = planSbpPersonTransition(catalog, official(), at);
    assert.equal(catalog.sourceSystem, CURRENT_C2B_SOURCE_SYSTEM);
    const upstream = {
      updatedAt: new Date(at.getTime() + 60000).toISOString(),
      banks: catalog.banks.map((bank) => ({ id: bank.nspkId, name: bank.sourceName ?? bank.name })),
    };
    assert.throws(() => reconcileSbpCatalog(preview.candidate, upstream), /C2B updater cannot overwrite/);
    const legacy = reconcileSbpCatalog(catalog, upstream);
    assert.equal(legacy.changed, false);
  });

  it('does not offer an unverified logo even if an existing bank asset has a real hash', () => {
    const result = planSbpPersonTransition(catalog, official(), at);
    const sber = result.candidate.banks.find((bank) => bank.id === 'sberbank');
    assert.equal(sber.icon, null);
    assert.equal(sber.nspkId, '100000000111');
    assert.equal(result.canPublishAutomatically, false);
    const audit = auditSbpPersonTransfers(catalog, official(), at);
    assert.equal(audit.matchedTotal, result.audit.matchedTotal);
  });
});
