#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryBankLogos } from './lib/sbp-logo-inventory.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await readFile(resolve(root, 'src/lib/sbp-bank-catalog.json'), 'utf8'));
const report = inventoryBankLogos(catalog, resolve(root, 'public'));
const output = JSON.stringify(report, null, 2) + '\n';
const index = process.argv.indexOf('--report');
if (index !== -1 && (!process.argv[index + 1] || process.argv.length > index + 2)) {
  throw new Error('Usage: npm run sbp:logos:audit -- --report /path/to/manifest.json');
}
if (index >= 0) await writeFile(resolve(process.argv[index + 1]), output, { mode: 0o600 });
else process.stdout.write(output);
console.error(
  'Local bank icons: ' +
    report.logoCount +
    '/' +
    report.total +
    ', without logo=' +
    report.missingCount +
    ', orphan assets=' +
    report.orphanedCount +
    '; legal rights NOT verified; no publication permitted.',
);
