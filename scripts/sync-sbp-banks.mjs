#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { reconcileSbpCatalog } from './lib/sbp-catalog-sync.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = resolve(root, 'src/lib/sbp-bank-catalog.json');
const sourceUrl = 'https://raw.githubusercontent.com/eav93/sbp/main/data/banks.json';

async function main() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(sourceUrl, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Upstream HTTP ' + response.status);
    const raw = await response.text();
    if (raw.length > 500000) throw new Error('Upstream response too large');
    const upstream = JSON.parse(raw);
    const current = JSON.parse(await readFile(catalogPath, 'utf8'));
    const result = reconcileSbpCatalog(current, upstream);
    console.log(JSON.stringify({ changed: result.changed, ...result.stats }, null, 2));
    if (result.changed) {
      await writeFile(catalogPath, JSON.stringify(result.catalog, null, 2) + '\n');
    }
  } finally {
    clearTimeout(timeout);
  }
}

main().catch((error) => {
  console.error('SBP registry sync refused:', error.message);
  process.exitCode = 1;
});
