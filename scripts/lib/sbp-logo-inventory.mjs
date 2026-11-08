import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const FILE_NAME = /^[a-z0-9-]+\.(?:svg|webp)$/;
const BANK_FILE = /^\/banks\/(?:[a-z]+\.svg|nspk\/\d{12}\.webp)$/;

function directoryFiles(base, prefix = '') {
  return readdirSync(join(base, prefix), { withFileTypes: true }).flatMap((entry) => {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) return directoryFiles(base, name);
    if (!entry.isFile()) throw new Error('Unsupported bank image directory entry');
    return [name.split(sep).join('/')];
  });
}

export function inventoryBankLogos(catalog, publicRoot) {
  if (!catalog || !Array.isArray(catalog.banks) || catalog.banks.length < 100) {
    throw new Error('Invalid local bank catalog');
  }
  const root = resolve(publicRoot, 'banks');
  const referenced = new Set();
  const logos = [];
  const missing = [];
  for (const bank of catalog.banks) {
    if (!bank || typeof bank.id !== 'string' || typeof bank.nspkId !== 'string' || typeof bank.name !== 'string')
      throw new Error('Invalid local bank record');
    if (bank.icon === null) {
      missing.push({ id: bank.id, nspkId: bank.nspkId, name: bank.name, reason: 'source-icon-unavailable' });
      continue;
    }
    if (typeof bank.icon !== 'string' || !BANK_FILE.test(bank.icon)) {
      throw new Error('Unsafe or remote bank icon: ' + bank.id);
    }
    if (referenced.has(bank.icon)) throw new Error('Duplicate icon path: ' + bank.icon);
    referenced.add(bank.icon);
    const file = resolve(publicRoot, '.' + bank.icon);
    if (!file.startsWith(root + sep)) throw new Error('Bank image outside local directory');
    const buffer = readFileSync(file);
    if (buffer.length < 70 || buffer.length > 1_000_000) {
      throw new Error('Invalid bank logo byte length: ' + bank.id);
    }
    if (bank.icon.endsWith('.webp')) {
      if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
        throw new Error('Invalid WEBP asset: ' + bank.id);
      }
    } else {
      const svg = buffer.toString('utf8');
      if (!svg.includes('<svg') || /<script|<foreignObject|onload\s*=|onerror\s*=|xlink:href|<image/i.test(svg)) {
        throw new Error('Unsafe SVG asset: ' + bank.id);
      }
    }
    logos.push({
      id: bank.id,
      nspkId: bank.nspkId,
      name: bank.name,
      localPath: bank.icon,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      bytes: buffer.length,
      provenance: bank.icon.includes('/nspk/') ? 'sbp-icons-github-snapshot' : 'melpnz-rblp-github-snapshot',
      usagePermission: 'not-verified',
    });
  }
  const orphanedAssets = directoryFiles(root)
    .filter((name) => {
      if (name === 'README.md' || name === 'nspk/README.md') return false;
      if (!FILE_NAME.test(name.split('/').at(-1))) throw new Error('Unrecognized asset extension: ' + name);
      return !referenced.has('/banks/' + name);
    })
    .sort();
  logos.sort((a, b) => a.id.localeCompare(b.id));
  missing.sort((a, b) => a.name.localeCompare(b.name, 'ru-RU'));
  return {
    catalogSource: catalog.source,
    sourceUpdatedAt: catalog.sourceUpdatedAt,
    total: catalog.banks.length,
    logoCount: logos.length,
    missingCount: missing.length,
    orphanedCount: orphanedAssets.length,
    logos,
    missing,
    orphanedAssets,
    allUsagePermissionsVerified: false,
    currentC2cMembershipVerified: false,
    canPublishChanges: false,
    notes: [
      'Hashes and file types establish integrity only; they do not grant bank-trademark usage rights.',
      'The 8 SVG images originate from melpnz/rblp; the 177 WEBP images from sbp-icons/sbp-icons. Brand usage permissions are not established.',
      'The catalog is a C2B registry and does not establish person-transfer eligibility.',
      'Missing logos must remain clearly labeled textual placeholders until rights and provenance are checked.',
    ],
  };
}
