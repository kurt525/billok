import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import { AppError } from './app-error';
import { reserveSystemInvite } from './invite-reservation';

/**
 * Create an unverified invited account and reserve its invitation atomically.
 * Do not consume the invitation or sign the user in.
 *
 * Not yet wired into auth.register: the caller must first enforce the
 * .ru/.su email policy and registration mode; SMTP delivery and error
 * compensation are implemented by createAndDeliverPendingInviteRegistration.
 */
export async function createPendingInviteRegistration(
  db: PrismaClient,
  input: { name: string; email: string; inviteCode: string; now?: Date },
): Promise<{ id: string; name: string | null; email: string }> {
  const now = input.now ?? new Date();
  return db.$transaction(async (tx) => {
    const user = await tx.user
      .create({
        data: {
          name: input.name,
          email: input.email,
          emailVerified: null,
          registrationEmailVerificationRequired: true,
        },
      })
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new AppError('CONFLICT', 'emailTaken');
        }
        throw error;
      });

    const reserved = await reserveSystemInvite(tx, {
      code: input.inviteCode,
      userId: user.id,
      now,
    });
    if (!reserved) {
      // The transaction rollback deletes this new user as well, so a stolen,
      // expired or revoked invitation cannot permanently reserve its email.
      throw new AppError('FORBIDDEN', 'inviteCodeInvalid');
    }

    return { id: user.id, name: user.name, email: user.email };
  });
}
