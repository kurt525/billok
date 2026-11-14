'use client';

import { useState, useEffect } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Trash2, Loader2, Ban, CheckCircle2, UserCheck, Search, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { toast } from 'sonner';
import { localizedTrpcError } from '@/lib/localized-trpc-error';
import { approveOwnerUserAction, type OwnerUserAction } from '@/lib/owner-admin-approval';

type UserSortBy = 'name' | 'email' | 'groupCount' | 'createdAt';
type UserStatus = 'all' | 'active' | 'suspended' | 'placeholder';
type SortDirection = 'asc' | 'desc';

function SortIcon({
  column,
  currentSort,
  currentDirection,
}: {
  column: UserSortBy;
  currentSort: UserSortBy;
  currentDirection: SortDirection;
}) {
  if (column !== currentSort) {
    return <ArrowUpDown className="ml-1 inline h-3.5 w-3.5 text-muted-foreground/50" />;
  }
  return currentDirection === 'asc' ? (
    <ArrowUp className="ml-1 inline h-3.5 w-3.5" />
  ) : (
    <ArrowDown className="ml-1 inline h-3.5 w-3.5" />
  );
}

export function UserManagementSection({ currentUserEmail }: { currentUserEmail?: string | null }) {
  const t = useTranslations('admin');
  const tc = useTranslations('common');
  const locale = useLocale();
  const utils = trpc.useUtils();

  // Filter / search / sort state
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState<UserStatus>('all');
  const [sortBy, setSortBy] = useState<UserSortBy>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  // Debounce search input (300ms)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Infinite query with cursor pagination
  const users = trpc.admin.listUsers.useInfiniteQuery(
    {
      limit: 20,
      search: debouncedSearch || undefined,
      status,
      sortBy,
      sortDirection,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    },
  );

  const allUsers = users.data?.pages.flatMap((p) => p.users) ?? [];
  const totalCount = users.data?.pages[0]?.totalCount ?? 0;

  // Mutations
  const deleteUser = trpc.admin.deleteUser.useMutation({
    onSuccess: () => {
      utils.admin.listUsers.invalidate();
      utils.admin.getAuditLog.invalidate();
      setDeleteTarget(null);
    },
    onError: (e) => toast.error(localizedTrpcError(e, tc('errors.generic'))),
  });
  const suspendUser = trpc.admin.suspendUser.useMutation({
    onSuccess: () => {
      utils.admin.listUsers.invalidate();
      utils.admin.getAuditLog.invalidate();
    },
    onError: (e) => toast.error(localizedTrpcError(e, tc('errors.generic'))),
  });
  const unsuspendUser = trpc.admin.unsuspendUser.useMutation({
    onSuccess: () => {
      utils.admin.listUsers.invalidate();
      utils.admin.getAuditLog.invalidate();
    },
    onError: (e) => toast.error(localizedTrpcError(e, tc('errors.generic'))),
  });

  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string | null;
    email: string;
  } | null>(null);
  const [impersonating, setImpersonating] = useState(false);
  const [approvingUser, setApprovingUser] = useState(false);

  const approveAndChangeUser = async (action: OwnerUserAction, userId: string) => {
    if (approvingUser || suspendUser.isPending || unsuspendUser.isPending || deleteUser.isPending) return;
    setApprovingUser(true);
    try {
      const approvalToken = await approveOwnerUserAction(action, userId);
      if (action === 'USER_SUSPEND') await suspendUser.mutateAsync({ userId, approvalToken });
      if (action === 'USER_UNSUSPEND') await unsuspendUser.mutateAsync({ userId, approvalToken });
      if (action === 'USER_DELETE') await deleteUser.mutateAsync({ userId, approvalToken });
    } catch {
      toast.error('Действие не подтверждено через Passkey');
    } finally {
      setApprovingUser(false);
    }
  };

  const handleImpersonate = async (userId: string) => {
    setImpersonating(true);
    try {
      const res = await fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (res.ok) {
        // BillOK uses canonical, unprefixed Russian-only URLs.
        window.location.assign(new URL('/dashboard', window.location.origin).href);
      } else {
        toast.error('Не удалось войти от имени пользователя (код ' + res.status + ')');
      }
    } catch {
      toast.error('Не удалось войти от имени пользователя');
    } finally {
      setImpersonating(false);
    }
  };

  const handleSort = (column: UserSortBy) => {
    if (sortBy === column) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(column);
      setSortDirection('asc');
    }
  };

  const statuses: { value: UserStatus; label: string }[] = [
    { value: 'all', label: t('users.filterAll') },
    { value: 'active', label: t('users.filterActive') },
    { value: 'suspended', label: t('users.filterSuspended') },
    { value: 'placeholder', label: t('users.filterPlaceholder') },
  ];

  return (
    <section data-testid="admin-user-management" className="min-w-0">
      <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 className="min-w-0 text-lg font-semibold [overflow-wrap:anywhere]">{t('users.title')}</h2>
        <Badge variant="secondary" className="max-w-full whitespace-normal [overflow-wrap:anywhere]">
          {t('users.count', { count: totalCount })}
        </Badge>
      </div>

      {/* Filters toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {/* Status filter buttons */}
        <div className="flex min-w-0 flex-wrap gap-1">
          {statuses.map((s) => (
            <Button
              key={s.value}
              size="sm"
              variant={status === s.value ? 'default' : 'outline'}
              onClick={() => setStatus(s.value)}
              className="min-h-11 min-w-11 max-w-full px-3 py-2 text-xs whitespace-normal [overflow-wrap:anywhere]"
              data-testid={'admin-users-filter-' + s.value}
            >
              {s.label}
            </Button>
          ))}
        </div>

        {/* Search */}
        <div className="relative min-w-0 basis-full flex-1 sm:min-w-[180px] sm:basis-auto">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            data-testid="admin-users-search"
            aria-label={t('users.searchAriaLabel')}
            placeholder={t('users.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-h-11 min-w-0 w-full scroll-mt-20 pl-8 text-base"
          />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {users.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : users.isError ? (
            <div className="flex flex-col items-center gap-2 py-12 text-sm text-destructive">
              <p>{t('users.errorLoading')}</p>
              <Button variant="outline" size="sm" className="min-h-11 min-w-11" onClick={() => users.refetch()}>
                {t('users.retry')}
              </Button>
            </div>
          ) : allUsers.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">{t('users.noUsers')}</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="px-4 py-3 font-medium">
                        <button
                          type="button"
                          className="inline-flex min-h-11 min-w-11 items-center text-left whitespace-normal hover:text-foreground"
                          onClick={() => handleSort('name')}
                        >
                          {t('users.colName')}
                          <SortIcon column="name" currentSort={sortBy} currentDirection={sortDirection} />
                        </button>
                      </th>
                      <th className="px-4 py-3 font-medium">
                        <button
                          type="button"
                          className="inline-flex min-h-11 min-w-11 items-center text-left whitespace-normal hover:text-foreground"
                          onClick={() => handleSort('email')}
                        >
                          {t('users.colEmail')}
                          <SortIcon column="email" currentSort={sortBy} currentDirection={sortDirection} />
                        </button>
                      </th>
                      <th className="px-4 py-3 font-medium">{t('users.colStatus')}</th>
                      <th className="px-4 py-3 font-medium text-right">
                        <button
                          type="button"
                          className="inline-flex min-h-11 min-w-11 items-center text-left whitespace-normal hover:text-foreground"
                          onClick={() => handleSort('groupCount')}
                        >
                          {t('users.colGroups')}
                          <SortIcon column="groupCount" currentSort={sortBy} currentDirection={sortDirection} />
                        </button>
                      </th>
                      <th className="px-4 py-3 font-medium">
                        <button
                          type="button"
                          className="inline-flex min-h-11 min-w-11 items-center text-left whitespace-normal hover:text-foreground"
                          onClick={() => handleSort('createdAt')}
                        >
                          {t('users.colCreated')}
                          <SortIcon column="createdAt" currentSort={sortBy} currentDirection={sortDirection} />
                        </button>
                      </th>
                      <th className="px-4 py-3 font-medium">{t('users.colActions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allUsers.map((user) => (
                      <tr key={user.id} className="border-b last:border-0">
                        <td className="px-4 py-3 font-medium">{user.name ?? '---'}</td>
                        <td className="px-4 py-3 text-muted-foreground">{user.email}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {user.isPlaceholder ? (
                              <Badge variant="outline">{t('users.statusPlaceholder')}</Badge>
                            ) : (
                              <Badge variant="secondary">{t('users.statusUser')}</Badge>
                            )}
                            {user.isSuspended && <Badge variant="destructive">{t('users.statusSuspended')}</Badge>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">{user.groupCount}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {new Date(user.createdAt).toLocaleDateString(locale)}
                        </td>
                        <td className="px-4 py-3">
                          {user.email !== currentUserEmail && (
                            <div className="flex items-center gap-1">
                              {user.isSuspended ? (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  className="size-11 shrink-0"
                                  aria-label={t('users.unsuspend', { name: user.name ?? user.email })}
                                  onClick={() => void approveAndChangeUser('USER_UNSUSPEND', user.id)}
                                  disabled={approvingUser || unsuspendUser.isPending}
                                >
                                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                                </Button>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  className="size-11 shrink-0"
                                  aria-label={t('users.suspend', { name: user.name ?? user.email })}
                                  onClick={() => void approveAndChangeUser('USER_SUSPEND', user.id)}
                                  disabled={approvingUser || suspendUser.isPending}
                                >
                                  <Ban className="h-4 w-4 text-orange-600" />
                                </Button>
                              )}
                              {!user.isPlaceholder && (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  className="size-11 shrink-0"
                                  aria-label={t('users.impersonate', { name: user.name ?? user.email })}
                                  onClick={() => handleImpersonate(user.id)}
                                  disabled={impersonating}
                                >
                                  <UserCheck className="h-4 w-4 text-purple-600" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="size-11 shrink-0"
                                aria-label={t('users.deleteUser', { name: user.name ?? user.email })}
                                onClick={() =>
                                  setDeleteTarget({
                                    id: user.id,
                                    name: user.name,
                                    email: user.email,
                                  })
                                }
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {users.hasNextPage && (
                <div className="border-t px-4 py-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-11 min-w-11 whitespace-normal"
                    onClick={() => users.fetchNextPage()}
                    disabled={users.isFetchingNextPage}
                  >
                    {users.isFetchingNextPage && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('users.loadMore')}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent
          data-testid="admin-user-delete-dialog"
          className="min-w-0 overflow-x-hidden [overflow-wrap:anywhere] [&_[data-slot=dialog-close]]:size-11"
        >
          <DialogHeader className="min-w-0 pr-11">
            <DialogTitle className="min-w-0 [overflow-wrap:anywhere]">{t('users.deleteTitle')}</DialogTitle>
            <DialogDescription className="min-w-0 [overflow-wrap:anywhere]">
              {t.rich('users.deleteDescription', {
                name: deleteTarget?.name ?? deleteTarget?.email ?? '',
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Для удаления подтвердите действие через Passkey владельца.</p>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11 min-w-11 whitespace-normal"
              onClick={() => setDeleteTarget(null)}
              disabled={approvingUser || deleteUser.isPending}
            >
              {t('users.cancel')}
            </Button>
            <Button
              variant="destructive"
              className="min-h-11 min-w-11 whitespace-normal"
              onClick={() => deleteTarget && void approveAndChangeUser('USER_DELETE', deleteTarget.id)}
              disabled={approvingUser || deleteUser.isPending}
            >
              {deleteUser.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('users.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
