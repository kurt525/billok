import {
  auditSbpPersonTransfers,
  normalizeOfficialBankName,
  OFFICIAL_PERSON_TRANSFER_URL,
} from './sbp-person-transfer-audit.mjs';

export const CURRENT_C2B_SOURCE_SYSTEM = 'NSPK C2B bank registry (not a guarantee of C2C phone transfers)';
export const REVIEW_C2C_SOURCE_SYSTEM = 'NSPK C2C person-transfer (REVIEW ONLY)';

/**
 * Issue 4.3.2.3.1: create a non-deployable candidate for human inspection.
 *
 * An operator-provided JSON snapshot is not itself proof of NSPK origin.
 * This function never publishes, selects a bank in the application or loads
 * external artwork. No candidate is produced for ambiguous/unknown bank IDs.
 */
export function planSbpPersonTransition(catalog, officialSnapshot, at = new Date()) {
  if (catalog?.sourceSystem !== CURRENT_C2B_SOURCE_SYSTEM) {
    throw new Error('Transition requires the expected legacy NSPK C2B catalog');
  }
  const audit = auditSbpPersonTransfers(catalog, officialSnapshot, at);
  const blockers = [];
  if (audit.ambiguousTotal) blockers.push('AMBIGUOUS_IDENTITIES');
  const nameOnly = audit.matched.filter((bank) => bank.match !== 'official-member-id');
  if (nameOnly.length) blockers.push('NAME_ONLY_IDENTITIES_REQUIRE_VERIFICATION');
  const unknownCodes = audit.unmatchedOfficial.filter((bank) => bank.nspkId === null);
  if (unknownCodes.length) blockers.push('OFFICIAL_MEMBER_IDS_UNAVAILABLE');
  // Count every official row, not just the successfully matched subset:
  // ambiguous names must be visible even when the identity audit rejected them.
  const allOfficialNames = officialSnapshot.banks.map((bank) => normalizeOfficialBankName(bank.name ?? bank.title));
  const hasDuplicateNames = new Set(allOfficialNames).size !== allOfficialNames.length;
  if (hasDuplicateNames) blockers.push('DUPLICATED_OFFICIAL_NAMES');

  // Show blockers and report, but never emit any candidate that could silently
  // assign a new bank ID or confuse two brand names.
  if (blockers.length) {
    return {
      source: OFFICIAL_PERSON_TRANSFER_URL,
      fetchedAt: audit.fetchedAt,
      audit,
      blockers,
      candidate: null,
      canPublishAutomatically: false,
      requiresExplicitOwnerApproval: true,
      officialSourceProvenanceExternallyVerified: false,
    };
  }
  const matched = new Map(audit.matched.map((bank) => [bank.localId, bank]));
  const retained = catalog.banks.map((bank) => {
    const official = matched.get(bank.id);
    // C2B-only banks must not be selectable in a future C2C-only catalog.
    // Existing bank IDs stay present for historical settings.
    const result = {
      ...bank,
      icon: null, // Rights for trademarks must be reviewed before release.
      ...(official ? {} : { active: false }),
    };
    if (official) {
      delete result.active;
      if (bank.id !== bank.nspkId) {
        result.sourceName = official.officialName;
      } else {
        result.name = official.officialName;
      }
    }
    return result;
  });
  const newBanks = audit.unmatchedOfficial
    .map((bank) => ({
      id: bank.nspkId,
      name: bank.name,
      nspkId: bank.nspkId,
      icon: null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru-RU') || a.id.localeCompare(b.id));
  const ids = [...retained, ...newBanks].map((bank) => bank.id);
  if (new Set(ids).size !== ids.length) {
    return {
      source: OFFICIAL_PERSON_TRANSFER_URL,
      fetchedAt: audit.fetchedAt,
      audit,
      blockers: ['COLLIDING_STABLE_IDS'],
      candidate: null,
      canPublishAutomatically: false,
      requiresExplicitOwnerApproval: true,
      officialSourceProvenanceExternallyVerified: false,
    };
  }
  return {
    source: OFFICIAL_PERSON_TRANSFER_URL,
    fetchedAt: audit.fetchedAt,
    audit,
    blockers: [],
    candidate: {
      source: OFFICIAL_PERSON_TRANSFER_URL,
      sourceUpdatedAt: audit.fetchedAt,
      sourceSystem: REVIEW_C2C_SOURCE_SYSTEM,
      banks: [...retained, ...newBanks],
    },
    reviewNotice:
      'Unverified human-supplied snapshot; all bank logo rights and current C2C membership need independent confirmation.',
    canPublishAutomatically: false,
    requiresExplicitOwnerApproval: true,
    officialSourceProvenanceExternallyVerified: false,
  };
}
