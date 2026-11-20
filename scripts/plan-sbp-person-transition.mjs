#!/usr/bin/env node
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSbpPersonTransition } from './lib/sbp-person-transfer-transition.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const snapshotAt = args.indexOf('--snapshot');
const reportAt = args.indexOf('--report');
const snapshotPath = snapshotAt >= 0 ? args[snapshotAt + 1] : null;
const reportPath = reportAt >= 0 ? args[reportAt + 1] : null;

if (!snapshotPath || snapshotPath.startsWith('--') || (reportAt >= 0 && (!reportPath || reportPath.startsWith('--')))) {
  console.error(
    'Usage: node scripts/plan-sbp-person-transition.mjs --snapshot /path/to/verified.json [--report /path/to/review.json]',
  );
  process.exitCode = 2;
} else {
  try {
    const [original, snapshot] = await Promise.all([
      readFile(resolve(root, 'src/lib/sbp-bank-catalog.json'), 'utf8'),
      readFile(resolve(snapshotPath), 'utf8'),
    ]);
    if (snapshot.length > 1_000_000) throw new Error('Oversized NSPK snapshot');
    const result = planSbpPersonTransition(JSON.parse(original), JSON.parse(snapshot));
    const report = JSON.stringify(result, null, 2) + '\n';
    if (reportPath) {
      const outputPath = resolve(reportPath);
      const projectRoot = await realpath(root);
      const outputDir = await realpath(dirname(outputPath));
      // A dry-run must never overwrite application files (even via a symlink).
      if (outputDir === projectRoot || outputDir.startsWith(projectRoot + sep)) {
        throw new Error('Dry-run report must be outside the BillOK checkout');
      }
      // Exclusive creation prevents overwriting an existing report or backup.
      await writeFile(outputPath, report, { mode: 0o600, flag: 'wx' });
    } else process.stdout.write(report);
    console.error(
      'SBP C2C dry-run only; candidate must never be deployed without verified NSPK membership and image permissions.',
    );
    if (result.blockers.length || !result.candidate) process.exitCode = 3;
  } catch (error) {
    console.error('SBP C2C transition plan refused: ' + error.message);
    process.exitCode = 1;
  }
}
