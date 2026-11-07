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
  return 'hsl(' + hueFor(guestVisualColorKey(person, fallbackIndex)) + ' 77% 38%)';
}

export function guestVisualColorStyle(person: GuestColorPerson | null | undefined, fallbackIndex = 0) {
  const key = guestVisualColorKey(person, fallbackIndex);
  const saturation = 63 + (Math.floor(key / 20) % 3) * 5;
  const lightness = 83 + (Math.floor(key / 60) % 2) * 3;
  return {
    backgroundColor: 'hsl(' + hueFor(key) + ' ' + saturation + '% ' + lightness + '%)',
    color: '#172033',
    borderColor: guestVisualColorBorder(person, fallbackIndex),
  };
}
