import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inventoryBankLogos } from './sbp-logo-inventory.mjs';

const root = resolve(import.meta.dirname, '../..');
const catalog = JSON.parse(readFileSync(resolve(root, 'src/lib/sbp-bank-catalog.json'), 'utf8'));

describe('BillOK Issue 4.3.2.4: provenance-safe local bank logo audit', () => {
  it('inventories all visible bank assets with hashes and no invented licenses', () => {
    const report = inventoryBankLogos(catalog, resolve(root, 'public'));
    assert.equal(report.total, catalog.banks.length);
    assert.equal(report.logoCount, catalog.banks.filter((bank) => bank.icon !== null).length);
    assert.equal(report.missingCount, catalog.banks.filter((bank) => bank.icon === null).length);
    assert.equal(report.logoCount + report.missingCount, report.total);
    assert.equal(report.allUsagePermissionsVerified, false);
    assert.equal(report.canPublishChanges, false);
    assert.ok(
      report.logos.every(
        (bank) =>
          /^[0-9a-f]{64}$/.test(bank.sha256) &&
          bank.usagePermission === 'not-verified' &&
          bank.localPath.startsWith('/banks/'),
      ),
    );
  });

  it('keeps ten explicit missing bank images, no invented artwork', () => {
    const report = inventoryBankLogos(catalog, resolve(root, 'public'));
    assert.deepEqual(
      report.missing.map((bank) => bank.id).sort(),
      catalog.banks
        .filter((bank) => bank.icon === null)
        .map((bank) => bank.id)
        .sort(),
    );
    assert.equal(
      report.missing.some((bank) => bank.name.includes('НООСФЕРА')),
      true,
    );
  });

  it('rejects remote, traversal or duplicate icon paths', () => {
    for (const invalidPath of ['https://img.example/logo.svg', '/banks/../secrets.txt', '/banks/nspk/foo.webp']) {
      const corrupted = structuredClone(catalog);
      corrupted.banks[0].icon = invalidPath;
      assert.throws(() => inventoryBankLogos(corrupted, resolve(root, 'public')), /Unsafe or remote bank icon/);
    }
    const corrupted = structuredClone(catalog);
    corrupted.banks[1].icon = corrupted.banks[0].icon;
    assert.throws(() => inventoryBankLogos(corrupted, resolve(root, 'public')), /Duplicate icon path/);
  });

  it('separates integrity from bank membership and rights to display marks', () => {
    const report = inventoryBankLogos(catalog, resolve(root, 'public'));
    assert.equal(report.currentC2cMembershipVerified, false);
    assert.ok(report.notes.some((note) => note.includes('integrity only')));
    assert.ok(report.logos.some((bank) => bank.provenance === 'melpnz-rblp-github-snapshot'));
    assert.ok(report.logos.some((bank) => bank.provenance === 'sbp-icons-github-snapshot'));
  });
});
