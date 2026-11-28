// Display/filter only: identity and authorization remain server-side.
const UUID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/iu;

export function normalizeSecurityActorUuid(value: string): string | null {
  const trimmed = value.trim();
  return UUID.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function securityActorPreview(value: string): string {
  return value.length > 8 ? value.slice(0, 8) + '…' : value;
}
