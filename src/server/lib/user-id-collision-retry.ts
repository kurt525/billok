import { Prisma } from '@/generated/prisma/client';

const MAX_ID_COLLISION_RETRIES = 3;

/**
 * Retry ONLY a collision on User.id, never email or other constraints.
 * Retry the entire transaction, not an aborted PostgreSQL statement.
 * Prisma User.create without an explicit id generates a new UUIDv4 per retry.
 */
export function isUserIdCollision(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = error.meta?.target;
  const modelName = error.meta?.modelName;
  if (modelName !== undefined && modelName !== 'User') return false;
  return (
    (Array.isArray(target) && target.length === 1 && target[0] === 'id') ||
    target === 'User_pkey' ||
    target === 'User_id_key'
  );
}

export async function retryUserIdCollision<T>(wholeTransaction: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await wholeTransaction();
    } catch (error) {
      if (!isUserIdCollision(error) || attempt >= MAX_ID_COLLISION_RETRIES) throw error;
    }
  }
}
