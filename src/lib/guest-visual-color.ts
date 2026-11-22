/**
 * Palette v2 is allocated only to NEW receipts via a reserved numeric range.
 * Old receipts keep their original visualColorId and their exact old HSL output.
 * An owner marker is emitted by the server only for the verified OwnerBootstrap account.
 */
export const GUEST_PALETTE_V2_BASE = 1_000_000;
export const GUEST_OWNER_COLOR_ID = 2_147_483_647;
export const GUEST_OWNER_FILL = '#BFDBFE';
export const GUEST_OWNER_BORDER = '#2563EB';

// Maximin selection in OKLab from pastel HSL candidates. The first 10 prioritize
// distinct hues, the first 20 keep away from the owner's reserved blue.
const FIRST_TWENTY: readonly (readonly [number, number, number])[] = [
  [0, 70, 84],
  [60, 78, 80],
  [240, 78, 80],
  [300, 78, 80],
  [155, 78, 80],
  [25, 62, 88],
  [265, 62, 84],
  [180, 62, 88],
  [100, 78, 80],
  [325, 70, 88],
  [335, 78, 80],
  [270, 78, 80],
  [30, 78, 80],
  [105, 70, 88],
  [315, 78, 84],
  [45, 78, 80],
  [0, 78, 80],
  [180, 62, 80],
  [240, 78, 84],
  [50, 78, 88],
];
function v2ColorKey(person: GuestColorPerson | null | undefined): number | null {
  const key = person?.visualColorId;
  return typeof key === 'number' &&
    Number.isSafeInteger(key) &&
    key >= GUEST_PALETTE_V2_BASE &&
    key < GUEST_PALETTE_V2_BASE + 100_000
    ? key - GUEST_PALETTE_V2_BASE
    : null;
}
function colorHue(key: number): number {
  return Number(((key * 137.50776405003785) % 360).toFixed(3));
}
function v2Values(key: number): readonly [number, number, number] {
  return FIRST_TWENTY[key] ?? [colorHue(key), 65 + (Math.floor(key / 20) % 3) * 5, 82 + (Math.floor(key / 60) % 2) * 4];
}
/**
 * BillOK 3.9: repeatable per-person color, NOT payment, registration or role.
 * The server assigns visualColorId once and retains it with the person.
 * Golden-angle hues spread neighboring participants far apart. Saturation
 * and lightness vary to avoid duplicates among 100 guests in one receipt.
 * Text uses high-contrast ink on pale fill. Identity is never color-only.
 */
const GOLDEN_ANGLE = 137.50776405003785;

export type GuestColorPerson = { visualColorId?: number; id?: string };

export function guestVisualColorKey(person: GuestColorPerson | null | undefined, fallbackIndex = 0): number {
  const saved = person?.visualColorId;
  if (typeof saved === 'number' && Number.isSafeInteger(saved) && saved >= 0) return saved;
  // Legacy receipt fallback: stable UUID survives deletion and reordering.
  if (person?.id) {
    let hash = 2166136261;
    for (let i = 0; i < person.id.length; i++) {
      hash = Math.imul(hash ^ person.id.charCodeAt(i), 16777619);
    }
    return hash >>> 0;
  }
  return Math.max(0, Math.floor(fallbackIndex));
}

function hueFor(key: number): number {
  return Number(((key * GOLDEN_ANGLE) % 360).toFixed(3));
}

export function guestVisualColorBorder(person: GuestColorPerson | null | undefined, fallbackIndex = 0): string {
  if (person?.visualColorId === GUEST_OWNER_COLOR_ID) return GUEST_OWNER_BORDER;
  const v2 = v2ColorKey(person);
  if (v2 !== null) {
    const [hue, saturation, lightness] = v2Values(v2);
    // Vary the border saturation/lightness as well as the fill: some
    // first-twenty colors share a hue but have different pastel brightness.
    return 'hsl(' + hue + ' ' + (77 + (lightness - 80)) + '% ' + (38 - (saturation - 62) / 8) + '%)';
  }
  return 'hsl(' + hueFor(guestVisualColorKey(person, fallbackIndex)) + ' 77% 38%)';
}

export function guestVisualColorStyle(person: GuestColorPerson | null | undefined, fallbackIndex = 0) {
  if (person?.visualColorId === GUEST_OWNER_COLOR_ID) {
    return { backgroundColor: GUEST_OWNER_FILL, color: '#172033', borderColor: GUEST_OWNER_BORDER };
  }
  const v2 = v2ColorKey(person);
  if (v2 !== null) {
    const [hue, saturation, lightness] = v2Values(v2);
    return {
      backgroundColor: 'hsl(' + hue + ' ' + saturation + '% ' + lightness + '%)',
      color: '#172033',
      borderColor: guestVisualColorBorder(person, fallbackIndex),
    };
  }
  const key = guestVisualColorKey(person, fallbackIndex);
  const saturation = 63 + (Math.floor(key / 20) % 3) * 5;
  const lightness = 83 + (Math.floor(key / 60) % 2) * 3;
  return {
    backgroundColor: 'hsl(' + hueFor(key) + ' ' + saturation + '% ' + lightness + '%)',
    color: '#172033',
    borderColor: guestVisualColorBorder(person, fallbackIndex),
  };
}
