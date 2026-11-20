import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  auditSbpPersonTransfers,
  normalizeOfficialBankName,
  OFFICIAL_PERSON_TRANSFER_URL,
  validateOfficialPersonSnapshot,
} from './sbp-person-transfer-audit.mjs';

const catalog = JSON.parse(readFileSync(new URL('../../src/lib/sbp-bank-catalog.json', import.meta.url)));
const now = new Date('2026-11-09T12:00:00.000Z');

function snapshot(
  banks = catalog.banks.map((bank) => ({
    name: bank.sourceName ?? bank.name,
    nspkId: bank.nspkId,
  })),
) {
  return {
    source: OFFICIAL_PERSON_TRANSFER_URL,
    type: 'person',
    labels: ['person-transfer'],
    fetchedAt: '2026-11-09T09:00:00.000Z',
    banks,
  };
}

describe('BillOK Issue 4.3.2: offline official person-transfer bank reconciliation', () => {
  it('compares synthetic complete ID roster but NEVER publishes on its own', () => {
    const report = auditSbpPersonTransfers(catalog, snapshot(), now);
    assert.equal(report.officialTotal, catalog.banks.length);
    assert.equal(report.matchedTotal, catalog.banks.length);
    assert.equal(report.unmatchedOfficialTotal, 0);
    assert.equal(report.unmatchedLocalTotal, 0);
    assert.equal(report.ambiguousTotal, 0);
    assert.equal(report.canPublishAutomatically, false);
    assert.equal(report.status, 'MANUAL_REVIEW_REQUIRED');
    assert.equal(report.matched.find((entry) => entry.localId === 'tbank').nspkId, '100000000004');
  });

  it('does not treat 204 - 195 as exactly 9 missing banks', () => {
    const base = snapshot().banks;
    const banks = base.slice(1);
    for (let i = 0; i < 10; i++) {
      banks.push({ name: 'Официальный условный банк ' + i, nspkId: String(900000000000 + i) });
    }
    assert.equal(banks.length, 204);
    const report = auditSbpPersonTransfers(catalog, snapshot(banks), now);
    assert.equal(report.officialTotal, 204);
    assert.equal(report.localTotal, 195);
    assert.equal(report.matchedTotal, 194);
    assert.equal(report.unmatchedOfficialTotal, 10);
    assert.equal(report.unmatchedLocalTotal, 1);
    assert.equal(report.canPublishAutomatically, false);
    assert.deepEqual(
      report.unmatchedLocal.map((bank) => bank.id),
      ['sberbank'],
    );
    assert.deepEqual(
      report.unmatchedOfficial.map((bank) => bank.name).sort(),
      Array.from({ length: 10 }, (_, index) => 'Официальный условный банк ' + index).sort(),
    );
    // The input is a purely synthetic fixture, NOT a claim about actual NSPK banks.
  });

  it('can reconcile a bank by unique exact normalized name without guessing a memberId', () => {
    const banks = snapshot().banks.map((bank) =>
      bank.nspkId === '100000000004' ? { title: 'Т-Банк', slug: 't-bank' } : bank,
    );
    const report = auditSbpPersonTransfers(catalog, snapshot(banks), now);
    assert.equal(report.matchedTotal, catalog.banks.length);
    assert.equal(report.matched.find((bank) => bank.localId === 'tbank').match, 'exact-normalized-name');
  });

  it('rejects ambiguous mapping by aliases, rather than choosing the first match', () => {
    const changed = structuredClone(catalog);
    changed.banks[1].sourceName = changed.banks[0].name;
    const data = snapshot().banks.map((bank) =>
      bank.nspkId === changed.banks[0].nspkId ? { name: changed.banks[0].name } : bank,
    );
    const report = auditSbpPersonTransfers(changed, snapshot(data), now);
    assert.equal(report.ambiguousTotal, 1);
    assert.equal(report.matchedTotal, catalog.banks.length - 1);
    assert.equal(report.canPublishAutomatically, false);
  });

  it('requires the precise NSPK personal-transfer filter, not QR/C2B or a Github source', () => {
    for (const bad of [
      { source: 'https://github.com/eav93/sbp' },
      { type: 'merchant' },
      { labels: ['person-transfer-qr'] },
      { labels: ['person-transfer', 'person-transfer-qr'] },
      { source: 'https://sbp.nspk.ru/participants?type=person' },
    ]) {
      assert.throws(() => validateOfficialPersonSnapshot({ ...snapshot(), ...bad }, now), /Wrong official source/);
    }
  });

  it('rejects a missing, stale, future or too-small official snapshot', () => {
    assert.throws(() => validateOfficialPersonSnapshot(null, now));
    assert.throws(
      () => validateOfficialPersonSnapshot({ ...snapshot(), fetchedAt: '2026-09-01T00:00:00.000Z' }, now),
      /stale/,
    );
    assert.throws(
      () => validateOfficialPersonSnapshot({ ...snapshot(), fetchedAt: '2026-11-11T00:00:00.000Z' }, now),
      /future/,
    );
    assert.throws(() => validateOfficialPersonSnapshot(snapshot(snapshot().banks.slice(0, 90)), now), /count/);
  });

  it('rejects duplicate official member IDs and unsafe bank names', () => {
    const banks = snapshot().banks;
    assert.throws(() => validateOfficialPersonSnapshot(snapshot([...banks, banks[0]]), now), /Repeated official/);
    const corrupt = [...banks];
    corrupt[2] = { name: '<script>alert(1)</script>', nspkId: banks[2].nspkId };
    assert.throws(() => validateOfficialPersonSnapshot(snapshot(corrupt), now), /Invalid official bank name/);
    corrupt[2] = { name: 'Bad ID', nspkId: '123' };
    assert.throws(() => validateOfficialPersonSnapshot(snapshot(corrupt), now), /Invalid official NSPK/);
  });

  it('retains immutable local stable ID and local logo information', () => {
    const report = auditSbpPersonTransfers(catalog, snapshot(), now);
    assert.equal(report.matched.find((x) => x.localId === 'sberbank').hasLocalLogo, true);
    assert.equal(report.matched.find((x) => x.localId === '100000000313').hasLocalLogo, false);
    assert.equal(catalog.banks.find((x) => x.id === 'sberbank').nspkId, '100000000111');
    assert.equal(normalizeOfficialBankName(' «АК-БАРС» '), normalizeOfficialBankName('АК БАРС'));
    assert.equal(
      report.matched.some((x) => x.localId === 'unknown-bank'),
      false,
    );
  });
});
