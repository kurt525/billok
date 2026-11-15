import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@/generated/prisma/client';

const { reserveInvite } = vi.hoisted(() => ({ reserveInvite: vi.fn() }));
vi.mock('./invite-reservation', () => ({ reserveSystemInvite: reserveInvite }));
import { createPendingInviteRegistration } from './pending-invite-registration';

function error(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.0.0',
    meta: { modelName: 'User', target },
  });
}
const user = { id: 'unique-uuid-v4', name: 'Тест', email: 'user@mail.ru' };
const create = vi.fn();
const transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn({ user: { create } }));
const db = { $transaction: transaction } as unknown as PrismaClient;
const registration = () =>
  createPendingInviteRegistration(db, {
    name: 'Тест',
    email: 'user@mail.ru',
    inviteCode: 'invite-1',
  });
beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue(user);
  reserveInvite.mockResolvedValue({ code: 'invite-1' });
});

describe('6.13.2: invited user registration cannot steal existing identity on collision', () => {
  it('retries a WHOLE transaction without passing an id or role in user.create', async () => {
    create.mockRejectedValueOnce(error(['id'])).mockResolvedValueOnce(user);
    expect(await registration()).toEqual(user);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);
    for (const [args] of create.mock.calls) {
      expect(args.data).not.toHaveProperty('id');
      expect(args.data).not.toHaveProperty('ownerId');
      expect(args.data).not.toHaveProperty('role');
      expect(args.data.emailVerified).toBeNull();
    }
    expect(reserveInvite).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ userId: user.id, code: 'invite-1' }),
    );
  });

  it('duplicate email is a conflict, not a new ID or an overwritten account', async () => {
    create.mockRejectedValueOnce(error(['email']));
    await expect(registration()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(create).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledOnce();
    expect(reserveInvite).not.toHaveBeenCalled();
  });

  it('invalid invite rolls back the created user together with the reservation', async () => {
    reserveInvite.mockResolvedValueOnce(null);
    await expect(registration()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(transaction).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
  });
});
