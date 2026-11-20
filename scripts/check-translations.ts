import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// BillOK supports ONLY Russian. Validate the actual production message files
// without retaining or reading abandoned source-locale catalogs.
const messagesDir = join(process.cwd(), 'messages');
const supportedLocale = 'ru';
const namespaces = [
  'common',
  'auth',
  'dashboard',
  'groups',
  'expenses',
  'settings',
  'admin',
  'split',
  'splits',
  'errors',
] as const;
const locales = readdirSync(messagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
if (locales.length !== 1 || locales[0] !== supportedLocale) {
  console.error('BillOK requires messages/ru only, received: ' + locales.join(', '));
  process.exit(1);
}

function getLeaves(data: unknown, key = ''): Array<{ key: string; text: string }> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid translation object: ' + key);
  }
  const leaves: Array<{ key: string; text: string }> = [];
  for (const [part, value] of Object.entries(data)) {
    const path = key ? key + '.' + part : part;
    if (typeof value === 'string') {
      leaves.push({ key: path, text: value });
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      leaves.push(...getLeaves(value, path));
    } else {
      throw new Error('Invalid translation value: ' + path);
    }
  }
  return leaves;
}

for (const ns of namespaces) {
  const path = join(messagesDir, supportedLocale, ns + '.json');
  if (!existsSync(path)) throw new Error('Missing ru namespace: ' + ns);
  const keys = getLeaves(JSON.parse(readFileSync(path, 'utf8')));
  if (!keys.length) throw new Error('Empty namespace: ' + ns);
  for (const item of keys) {
    if (!item.text.trim()) throw new Error('Empty Russian translation: ' + ns + '.' + item.key);
    if (/ShareTab/iu.test(item.text)) throw new Error('Legacy brand: ' + ns + '.' + item.key);
  }
}
const actual = readdirSync(join(messagesDir, supportedLocale))
  .filter((name) => name.endsWith('.json'))
  .sort();
const expected = namespaces.map((name) => name + '.json').sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error('Unexpected or missing ru namespaces: ' + actual.join(', '));
}
console.log('BillOK Russian-only translations: PASS (' + namespaces.length + ' namespaces)');
