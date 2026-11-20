import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { db } from '@/server/db';
import { requestPasskeyRecovery } from '@/server/lib/passkey-email-recovery';
import { getClientIp } from '@/server/lib/client-ip';
import { checkRateLimit } from '@/server/lib/rate-limit';
import { logger } from '@/server/lib/logger';
import { readBoundedJson } from '@/server/lib/read-bounded-json';

// Identical response for known and unknown emails. No account lookup leaks.
const generic = () => NextResponse.json({ requested: true }, { status: 202 });

export async function POST(request: Request) {
  const ip = getClientIp(request.headers);
  if (
    !checkRateLimit('passkey-recovery-ip:' + ip, 12, 60 * 60 * 1000).allowed ||
    !checkRateLimit('passkey-recovery-global', 150, 60 * 60 * 1000).allowed
  )
    return generic();
  try {
    const body = await readBoundedJson(request, 512);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as { email?: unknown }).email !== 'string'
    )
      return generic();
    const email = (body as { email: string }).email;
    if (email.length > 254) return generic();
    const normalized = email.trim().toLowerCase();
    const key = createHash('sha256').update(normalized).digest('hex');
    if (!checkRateLimit('passkey-recovery-email:' + key, 3, 60 * 60 * 1000).allowed) return generic();
    await requestPasskeyRecovery({ db, email: normalized, env: process.env });
  } catch (error) {
    logger.warn('auth.passkey_recovery_request_failed', { error: error instanceof Error ? error.name : 'unknown' });
  }
  return generic();
}
