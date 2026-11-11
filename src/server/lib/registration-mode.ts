import type { PrismaClient } from '@/generated/prisma/client';

export const REGISTRATION_MODES = ['open', 'invite-only', 'closed'] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

/**
 * The admin's Registration setting. No setting, or a value ShareTab doesn't
 * know, reads as open. `auth.register` adds its own rule on top: with
 * password login disabled the register form is closed whatever this says.
 */
export async function readRegistrationMode(db: PrismaClient): Promise<RegistrationMode> {
  const setting = await db.systemSetting.findUnique({ where: { key: 'registrationMode' }, select: { value: true } });
  return REGISTRATION_MODES.find((mode) => mode === setting?.value) ?? 'open';
}

/**
 * Reads the administrative registration setting, subject to
 * BillOK's invitation-only and approved-email-domain restrictions.
 */
export async function isRegistrationOpen(db: PrismaClient): Promise<boolean> {
  return (await readRegistrationMode(db)) === 'open';
}
