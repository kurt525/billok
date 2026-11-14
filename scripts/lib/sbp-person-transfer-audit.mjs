/**
 * Issue 4.3.2 — offline, fail-closed comparison of an explicitly collected
 * official NSPK person-transfer snapshot and the supplementary C2B catalog.
 *
 * This module NEVER changes selectable banks, phone payment details or
 * deployed assets. A snapshot is review evidence, not authority to publish.
 * NSPK does not currently provide a verified accessible export to ci-runner.
 */
export const OFFICIAL_PERSON_TRANSFER_URL = 'https://sbp.nspk.ru/participants?type=person&labels=person-transfer';
export const MIN_OFFICIAL_BANKS = 100;
export const MAX_OFFICIAL_BANKS = 600;
const MAX_SNAPSHOT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const BANK_ID = /^\d{12}$/;
const INVALID_TEXT = /[<>\x00-\x1f]/;

function cleanName(value) {
  if (typeof value !== 'string') throw new Error('Bank name must be a string');
  const name = value.trim();
  if (name.length < 2 || name.length > 140 || INVALID_TEXT.test(name)) {
    throw new Error('Invalid official bank name');
  }
  return name;
}

/** Normalize only display-neutral differences; no fuzzy corporate or brand
 * assumptions (e.g. PayinRussia vs Promselhozbank) are ever inferred.
 */
export function normalizeOfficialBankName(name) {
  return cleanName(name)
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[«»"'.,()\-–—\s]+/g, '')
    .normalize('NFKC');
}

export function validateOfficialPersonSnapshot(snapshot, at = new Date()) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('Expected an NSPK snapshot object');
  }
  if (
    snapshot.source !== OFFICIAL_PERSON_TRANSFER_URL ||
    snapshot.type !== 'person' ||
    !Array.isArray(snapshot.labels) ||
    snapshot.labels.length !== 1 ||
    snapshot.labels[0] !== 'person-transfer'
  ) {
    throw new Error('Wrong official source or service filter');
  }
  if (typeof snapshot.fetchedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(snapshot.fetchedAt)) {
    throw new Error('Missing verified official snapshot timestamp');
  }
  const received = Date.parse(snapshot.fetchedAt);
  const now = new Date(at).getTime();
  if (
    !Number.isFinite(received) ||
    !Number.isFinite(now) ||
    received > now + 5 * 60 * 1000 ||
    now - received > MAX_SNAPSHOT_AGE_MS
  ) {
    throw new Error('Official NSPK snapshot missing, stale or from future');
  }
  if (
    !Array.isArray(snapshot.banks) ||
    snapshot.banks.length < MIN_OFFICIAL_BANKS ||
    snapshot.banks.length > MAX_OFFICIAL_BANKS
  ) {
    throw new Error('Suspicious official person-transfer bank count');
  }
  const seenIds = new Set();
  const parsed = snapshot.banks.map((bank) => {
    if (!bank || typeof bank !== 'object' || Array.isArray(bank)) {
      throw new Error('Invalid official bank entry');
    }
    const name = cleanName(bank.name ?? bank.title);
    // NSPK page's internal numeric id and slug are NOT a 12-digit bank
    // member code. Use only an explicit field with independently verified
    // member-id semantics; never infer a member code from array position.
    const code = bank.nspkId ?? bank.memberId ?? null;
    if (code !== null && (!BANK_ID.test(code) || typeof code !== 'string')) {
      throw new Error('Invalid official NSPK member ID');
    }
    if (code && seenIds.has(code)) throw new Error('Repeated official NSPK member ID');
    if (code) seenIds.add(code);
    return { name, nspkId: code, normalizedName: normalizeOfficialBankName(name) };
  });
  return { source: snapshot.source, fetchedAt: snapshot.fetchedAt, banks: parsed };
}

export function auditSbpPersonTransfers(currentCatalog, snapshot, at = new Date()) {
  const official = validateOfficialPersonSnapshot(snapshot, at);
  if (!currentCatalog || !Array.isArray(currentCatalog.banks) || currentCatalog.banks.length < MIN_OFFICIAL_BANKS) {
    throw new Error('Missing or invalid supplementary local bank catalog');
  }
  const localById = new Map();
  const localByName = new Map();
  for (const bank of currentCatalog.banks) {
    if (!bank || typeof bank.id !== 'string' || !BANK_ID.test(bank.nspkId) || typeof bank.name !== 'string') {
      throw new Error('Invalid local SBP catalog');
    }
    if (localById.has(bank.nspkId)) throw new Error('Duplicate local bank member ID');
    localById.set(bank.nspkId, bank);
    for (const text of [bank.name, bank.sourceName]) {
      if (!text) continue;
      const key = normalizeOfficialBankName(text);
      const ids = localByName.get(key) ?? new Set();
      ids.add(bank.id);
      localByName.set(key, ids);
    }
  }
  const usedLocal = new Set();
  const matched = [];
  const unmatchedOfficial = [];
  const ambiguous = [];
  for (const source of official.banks) {
    const direct = source.nspkId ? localById.get(source.nspkId) : null;
    const ids = localByName.get(source.normalizedName) ?? new Set();
    const candidates = direct ? [direct] : [...ids].map((id) => currentCatalog.banks.find((bank) => bank.id === id));
    if (candidates.length > 1 || (direct && ids.size && !ids.has(direct.id))) {
      ambiguous.push({
        name: source.name,
        nspkId: source.nspkId,
        candidates: [...new Set(candidates.map((bank) => bank.id))],
      });
      continue;
    }
    const target = candidates[0];
    if (!target) {
      unmatchedOfficial.push({ name: source.name, nspkId: source.nspkId });
      continue;
    }
    if (usedLocal.has(target.id)) {
      ambiguous.push({
        name: source.name,
        nspkId: source.nspkId,
        candidates: [target.id],
        reason: 'duplicate local mapping',
      });
      continue;
    }
    usedLocal.add(target.id);
    matched.push({
      officialName: source.name,
      nspkId: target.nspkId,
      localId: target.id,
      localName: target.name,
      match: direct ? 'official-member-id' : 'exact-normalized-name',
      hasLocalLogo: typeof target.icon === 'string' && target.icon.startsWith('/banks/'),
      retired: target.active === false,
    });
  }
  const unmatchedLocal = currentCatalog.banks
    .filter((bank) => !usedLocal.has(bank.id))
    .map((bank) => ({ id: bank.id, nspkId: bank.nspkId, name: bank.name, active: bank.active !== false }));
  matched.sort((a, b) => a.officialName.localeCompare(b.officialName, 'ru-RU'));
  unmatchedOfficial.sort((a, b) => a.name.localeCompare(b.name, 'ru-RU'));
  unmatchedLocal.sort((a, b) => a.name.localeCompare(b.name, 'ru-RU'));
  ambiguous.sort((a, b) => a.name.localeCompare(b.name, 'ru-RU'));
  return {
    source: official.source,
    fetchedAt: official.fetchedAt,
    officialTotal: official.banks.length,
    localTotal: currentCatalog.banks.length,
    matchedTotal: matched.length,
    unmatchedOfficialTotal: unmatchedOfficial.length,
    unmatchedLocalTotal: unmatchedLocal.length,
    ambiguousTotal: ambiguous.length,
    matched,
    unmatchedOfficial,
    unmatchedLocal,
    ambiguous,
    canPublishAutomatically: false,
    status: 'MANUAL_REVIEW_REQUIRED',
    notes: [
      'Source is an operator-supplied official snapshot; provenance must be verified before any catalog change.',
      'Missing, ambiguous and name-only matches never create active banks automatically.',
      'The supplementary C2B catalog is not a substitute for the official person-transfer membership list.',
      'No automatic deployment, image download, or bank identity rewriting is performed by this audit.',
    ],
  };
}
