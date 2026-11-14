#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSbpPersonTransfers, OFFICIAL_PERSON_TRANSFER_URL } from './lib/sbp-person-transfer-audit.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const snapshotIndex = args.indexOf('--snapshot');
const reportIndex = args.indexOf('--report');
const snapshotPath = snapshotIndex >= 0 ? args[snapshotIndex + 1] : null;
const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : null;
if (!snapshotPath || snapshotPath.startsWith('--') || (reportIndex >= 0 && !reportPath)) {
  console.error(
    'Usage: node scripts/audit-sbp-person-transfers.mjs --snapshot verified-nspk-person-transfer.json [--report report.json]',
  );
  console.error('Official source: ' + OFFICIAL_PERSON_TRANSFER_URL);
  console.error('No automatic fallback to the C2B registry and no network authentication bypass.');
  process.exitCode = 2;
} else {
  try {
    const [rawSnapshot, rawLocal] = await Promise.all([
      readFile(resolve(snapshotPath), 'utf8'),
      readFile(resolve(root, 'src/lib/sbp-bank-catalog.json'), 'utf8'),
    ]);
    if (rawSnapshot.length > 1_000_000) throw new Error('Official snapshot too large');
    const report = auditSbpPersonTransfers(JSON.parse(rawLocal), JSON.parse(rawSnapshot));
    const serialized = JSON.stringify(report, null, 2) + '\n';
    if (reportPath) {
      await writeFile(resolve(reportPath), serialized, { flag: 'w', mode: 0o600 });
    } else {
      process.stdout.write(serialized);
    }
    console.error(
      'SBP official reconciliation: ' +
        report.status +
        '; official=' +
        report.officialTotal +
        ', local=' +
        report.localTotal +
        ', matched=' +
        report.matchedTotal +
        ', missing=' +
        report.unmatchedOfficialTotal +
        ', not-official=' +
        report.unmatchedLocalTotal +
        ', ambiguous=' +
        report.ambiguousTotal,
    );
    // Exit nonzero unless every official bank is explicitly matched.
    if (report.unmatchedOfficialTotal || report.unmatchedLocalTotal || report.ambiguousTotal) {
      process.exitCode = 3;
    }
  } catch (error) {
    console.error('Official SBP reconciliation refused: ' + error.message);
    process.exitCode = 1;
  }
}
