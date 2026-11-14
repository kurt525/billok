/** 6.12.4.3: canonical, exact seven-day system-invite creation scope.
 * Distinct sentinel prevents an unlabeled invite from colliding with a real
 * label. The same deterministic value is computed by browser and server.
 */
export function systemInviteCreateApprovalTarget(label?: string): string {
  const normalized = label?.trim();
  if (normalized && normalized.length > 100) throw new Error('Invalid invite label');
  return normalized ? 'invite:v1:7:label:' + normalized : 'invite:v1:7:none';
}
