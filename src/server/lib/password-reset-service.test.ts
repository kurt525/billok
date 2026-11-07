import { beforeEach, describe, expect, it, vi } from 'vitest';
import { issuePasswordReset, redeemPasswordReset } from './password-reset-service';

const { lookup, send } = vi.hoisted(() => ({ lookup: vi.fn(), send: vi.fn() }));
vi.mock('./user-email', () => ({ findUsersByEmail: lookup }));
vi.mock('./password-reset-email', () => ({ sendRussianPasswordResetEmail: send }));
vi.mock('./logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('bcryptjs', () => ({ default: { hash: vi.fn(async () => 'hashed-new') } }));

const now = new Date('2026-11-01T12:00:00.000Z');
const person = {
  id: 'u1',
  email: 'member@mail.ru',
  emailVerified: now,
  passwordHash: 'old',
  suspendedAt: null,
  isPlaceholder: false,
};
const create = vi.fn();
const deleteMany = vi.fn();
const updateMany = vi.fn();
const findUnique = vi.fn();
const userFind = vi.fn();
const userUpdate = vi.fn();
const tx = {
  passwordResetRequest: { findUnique, updateMany },
  user: { findUnique: userFind, updateMany: userUpdate },
};
const transaction = vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
const db = { passwordResetRequest: { create, deleteMany, updateMany }, $transaction: transaction };

beforeEach(() => {
  vi.clearAllMocks();
  lookup.mockResolvedValue([person]);
  create.mockResolvedValue({ id: 'request-1', createdAt: now });
  send.mockResolvedValue(undefined);
  updateMany.mockResolvedValue({ count: 1 });
  userFind.mockResolvedValue(person);
  userUpdate.mockResolvedValue({ count: 1 });
  findUnique.mockResolvedValue({
    id: 'request-1',
    userId: person.id,
    expiresAt: new Date('2026-11-01T12:30:00Z'),
    consumedAt: null,
  });
});

describe('password reset service', () => {
  const options = {
    db: db as never,
    email: person.email,
    siteOrigin: 'https://billok.ru',
    from: 'BillOK <noreply@billok.ru>',
    server: { host: 'smtp.invalid', port: 465, secure: true },
  };
  it('delivers only to exactly one verified password account', async () => {
    await issuePasswordReset(options);
    expect(create).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(updateMany).toHaveBeenCalledOnce();
  });
  it('refuses unverified or ambiguous accounts without sending', async () => {
    lookup.mockResolvedValueOnce([{ ...person, emailVerified: null }]);
    await issuePasswordReset(options);
    lookup.mockResolvedValueOnce([person, { ...person, id: 'u2' }]);
    await issuePasswordReset(options);
    expect(send).not.toHaveBeenCalled();
  });
  it('removes only its new token if SMTP rejects the delivery', async () => {
    send.mockRejectedValueOnce(new Error('SMTP unavailable'));
    await expect(issuePasswordReset(options)).rejects.toThrow('SMTP unavailable');
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: 'request-1', userId: 'u1', consumedAt: null },
    });
  });
  it('atomically consumes a valid link and sets a new password', async () => {
    const token = 'A'.repeat(43);
    await expect(redeemPasswordReset(db as never, token, 'password-123', now)).resolves.toBe(true);
    expect(transaction).toHaveBeenCalledOnce();
    expect(userUpdate).toHaveBeenCalledWith({
      where: {
        id: 'u1',
        emailVerified: { not: null },
        passwordHash: { not: null },
        suspendedAt: null,
        isPlaceholder: false,
      },
      data: { passwordHash: 'hashed-new' },
    });
    expect(updateMany).toHaveBeenCalledTimes(2);
  });
  it('rejects expired, reused and invalid-format links before changing password', async () => {
    findUnique.mockResolvedValueOnce({ id: 'request-1', userId: 'u1', consumedAt: null, expiresAt: now });
    await expect(redeemPasswordReset(db as never, 'A'.repeat(43), 'password-123', now)).resolves.toBe(false);
    findUnique.mockResolvedValueOnce({
      id: 'request-1',
      userId: 'u1',
      consumedAt: now,
      expiresAt: new Date('2026-11-01T12:30:00Z'),
    });
    await expect(redeemPasswordReset(db as never, 'A'.repeat(43), 'password-123', now)).resolves.toBe(false);
    await expect(redeemPasswordReset(db as never, 'bad', 'password-123', now)).resolves.toBe(false);
    expect(userUpdate).not.toHaveBeenCalled();
  });
  it('does not change password if another request won the token race', async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(redeemPasswordReset(db as never, 'A'.repeat(43), 'password-123', now)).resolves.toBe(false);
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
