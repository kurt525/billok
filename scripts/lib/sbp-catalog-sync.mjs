const MIN_BANKS = 100;
const MAX_BANKS = 600;
const MAX_REMOVAL_RATIO = 0.2;

function idIsValid(value) {
  return typeof value === 'string' && /^\d{12}$/.test(value);
}

export function reconcileSbpCatalog(current, source) {
  if (!current || !Array.isArray(current.banks) || current.banks.length < MIN_BANKS) {
    throw new Error('Missing or invalid local SBP catalog');
  }
  const date = Date.parse(source?.updatedAt);
  if (!Number.isFinite(date)) throw new Error('Invalid upstream catalog date');
  if (!Array.isArray(source.banks) || source.banks.length < MIN_BANKS || source.banks.length > MAX_BANKS) {
    throw new Error('Suspicious upstream SBP bank count');
  }
  if (Date.parse(current.sourceUpdatedAt) > date) throw new Error('Upstream data is older than current catalog');

  const byRegistryId = new Map();
  for (const bank of source.banks) {
    if (!idIsValid(bank.id) || typeof bank.name !== 'string') {
      throw new Error('Invalid upstream bank ID or name');
    }
    const name = bank.name.trim();
    if (name.length < 2 || name.length > 120 || /[<>\x00-\x1f]/.test(name)) {
      throw new Error('Invalid upstream bank display name');
    }
    if (byRegistryId.has(bank.id)) throw new Error('Duplicate upstream bank ID');
    byRegistryId.set(bank.id, name);
  }

  const seen = new Set();
  const banks = current.banks.map((bank) => {
    if (!idIsValid(bank.nspkId) || seen.has(bank.nspkId)) throw new Error('Invalid current catalog ID');
    seen.add(bank.nspkId);
    const upstreamName = byRegistryId.get(bank.nspkId);
    if (upstreamName === undefined) {
      return bank.active === false ? bank : { ...bank, active: false };
    }
    // For legacy IDs the UI name may be prettier than the registry name.
    // Only replace it if the actual upstream name has changed.
    const isLegacy = bank.id !== bank.nspkId;
    const previousName = isLegacy ? (bank.sourceName ?? upstreamName) : bank.name;
    const renamed = upstreamName !== previousName;
    const result = { ...bank, name: renamed ? upstreamName : bank.name };
    if (isLegacy) result.sourceName = upstreamName;
    delete result.active;
    return result;
  });

  const removed = banks.filter(
    (bank) =>
      bank.active === false && current.banks.some((previous) => previous.id === bank.id && previous.active !== false),
  ).length;
  const activeBefore = current.banks.filter((bank) => bank.active !== false).length;
  if (removed > Math.ceil(activeBefore * MAX_REMOVAL_RATIO)) {
    throw new Error('Excessive upstream removals: manual review required');
  }

  const added = [];
  for (const [id, name] of byRegistryId) {
    if (seen.has(id)) continue;
    added.push({ id, name, nspkId: id, icon: null });
  }
  added.sort((a, b) => a.name.localeCompare(b.name, 'ru-RU') || a.id.localeCompare(b.id));
  banks.push(...added);

  const previousBanks = JSON.stringify(current.banks);
  const changed = previousBanks !== JSON.stringify(banks);
  return {
    changed,
    catalog: changed ? { ...current, sourceUpdatedAt: source.updatedAt, banks } : current,
    stats: {
      added: added.length,
      removed,
      renamed: banks.filter((bank, i) => i < current.banks.length && bank.name !== current.banks[i].name).length,
    },
  };
}
