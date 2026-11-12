import { beforeEach, describe, expect, it, vi } from 'vitest';
const { authMock, cookieMock, bootstrapMock, userMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  cookieMock: vi.fn(),
  bootstrapMock: vi.fn(),
  userMock: vi.fn(),
}));
vi.mock('@/server/auth', () => ({ auth: authMock }));
vi.mock('@/server/db', () => ({
  db: {
    ownerBootstrap: { findUnique: bootstrapMock },
    user: { findUnique: userMock },
  },
}));
vi.mock('next/headers', () => ({ cookies: cookieMock }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw Error('route-404');
  },
  redirect: () => {
    throw Error('route-redirect');
  },
}));
vi.mock('@/components/admin/owner-users-client', () => ({
  OwnerUsersClient: () => null,
}));
import OwnerUsersPage from './page';

const render = () => OwnerUsersPage({ params: Promise.resolve({ locale: 'ru' }) });
beforeEach(() => {
  vi.resetAllMocks();
  authMock.mockResolvedValue({ user: { id: 'owner' } });
  cookieMock.mockResolvedValue({ get: vi.fn(() => undefined) });
  bootstrapMock.mockResolvedValue({ userId: 'owner', completedAt: new Date() });
  userMock.mockResolvedValue({ emailVerified: new Date(), suspendedAt: null, isPlaceholder: false });
});
describe('Issue #1 6.11: separate admin/users is owner-only before rendering data', () => {
  it('renders only for a real signed-in owner with completed bootstrap', async () => {
    const page = await render();
    expect(page).toHaveProperty('type');
    expect(bootstrapMock).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { userId: true, completedAt: true },
    });
    expect(userMock).toHaveBeenCalledWith({
      where: { id: 'owner' },
      select: { emailVerified: true, suspendedAt: true, isPlaceholder: true },
    });
  });
  it('redirects anonymous visitors before any owner information is loaded', async () => {
    authMock.mockResolvedValue(null);
    await expect(render()).rejects.toThrow('route-redirect');
    expect(bootstrapMock).not.toHaveBeenCalled();
  });
  it('hides the page from a normal signed-in registered user', async () => {
    authMock.mockResolvedValue({ user: { id: 'member' } });
    await expect(render()).rejects.toThrow('route-404');
  });
  it('blocks impersonation, even when the owner session is otherwise genuine', async () => {
    cookieMock.mockResolvedValueOnce({ get: vi.fn(() => ({ value: 'signed-impersonation' })) });
    await expect(render()).rejects.toThrow('route-404');
    expect(bootstrapMock).not.toHaveBeenCalled();
  });
  it('rejects incomplete bootstrap, suspended owner and placeholder owner', async () => {
    bootstrapMock.mockResolvedValueOnce({ userId: 'owner', completedAt: null });
    await expect(render()).rejects.toThrow('route-404');
    userMock.mockResolvedValueOnce({ emailVerified: new Date(), suspendedAt: new Date(), isPlaceholder: false });
    await expect(render()).rejects.toThrow('route-404');
    userMock.mockResolvedValueOnce({ emailVerified: new Date(), suspendedAt: null, isPlaceholder: true });
    await expect(render()).rejects.toThrow('route-404');
  });
});
