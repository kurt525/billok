'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ArrowLeft, ArrowDownUp, LoaderCircle, Search, ShieldCheck, Users } from 'lucide-react';
import { toast } from 'sonner';
import { approveOwnerUserAction } from '@/lib/owner-admin-approval';

type Status = 'all' | 'active' | 'suspended' | 'pending';
type Sort = 'name' | 'email' | 'createdAt';
type Direction = 'asc' | 'desc';

export function OwnerUsersClient() {
  const t = useTranslations('admin.ownerUsers');
  const locale = useLocale();
  const utils = trpc.useUtils();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<Status>('all');
  const [sortBy, setSortBy] = useState<Sort>('createdAt');
  const [direction, setDirection] = useState<Direction>('desc');
  const [selected, setSelected] = useState<{ id: string; name: string; suspend: boolean } | null>(null);
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const list = trpc.admin.ownerRegisteredUsers.useInfiniteQuery(
    { limit: 20, search: debounced || undefined, status, sortBy, sortDirection: direction },
    { getNextPageParam: (last) => last.nextCursor },
  );
  const entries = list.data?.pages.flatMap((page) => page.users) ?? [];
  const count = list.data?.pages[0]?.totalCount ?? 0;
  const setSuspended = trpc.admin.ownerSetUserSuspended.useMutation({
    onSuccess: async (_, variables) => {
      setSelected(null);
      await Promise.all([utils.admin.ownerRegisteredUsers.invalidate(), utils.admin.getAuditLog.invalidate()]);
      toast.success(variables.suspend ? t('blocked') : t('unblocked'));
    },
    onError: () => toast.error(t('mutationFailed')),
  });

  async function confirmWithPasskey() {
    if (!selected || approving || setSuspended.isPending) return;
    setApproving(true);
    try {
      const approvalToken = await approveOwnerUserAction(
        selected.suspend ? 'USER_SUSPEND' : 'USER_UNSUSPEND',
        selected.id,
      );
      await setSuspended.mutateAsync({ userId: selected.id, suspend: selected.suspend, approvalToken });
    } catch {
      // Cancellation, malformed assertion and server refusal are fail-closed.
      toast.error('Действие не подтверждено через Passkey');
    } finally {
      setApproving(false);
    }
  }

  return (
    <div data-testid="owner-users-page" className="min-w-0 space-y-5">
      <Link href="/admin" className="inline-flex min-h-11 min-w-0 items-center gap-2 text-sm text-primary">
        <ArrowLeft className="size-4 shrink-0" />
        <span className="break-words">{t('back')}</span>
      </Link>
      <div className="flex min-w-0 items-start gap-3">
        <Users className="mt-1 size-6 shrink-0 text-primary" />
        <div className="min-w-0 space-y-1">
          <h1 className="break-words text-2xl font-bold">{t('title')}</h1>
          <p className="break-words text-sm text-muted-foreground">{t('description')}</p>
        </div>
      </div>
      <div className="space-y-3">
        <div className="relative min-w-0">
          <Search className="absolute top-3.5 left-3 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label={t('search')}
            placeholder={t('search')}
            data-testid="owner-users-search"
            className="min-h-11 w-full min-w-0 pl-10 text-base"
          />
        </div>
        <div className="flex min-w-0 flex-wrap gap-2" data-testid="owner-users-filters">
          {(['all', 'active', 'suspended', 'pending'] as const).map((option) => (
            <Button
              key={option}
              type="button"
              variant={status === option ? 'default' : 'outline'}
              className="min-h-11 min-w-11 max-w-full whitespace-normal"
              data-testid={'owner-users-filter-' + option}
              onClick={() => setStatus(option)}
            >
              {t(('filter.' + option) as 'filter.all' | 'filter.active' | 'filter.suspended' | 'filter.pending')}
            </Button>
          ))}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ArrowDownUp className="size-4 shrink-0" />
          <label htmlFor="owner-users-sort" className="text-sm">
            {t('sortLabel')}
          </label>
          <select
            id="owner-users-sort"
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value as Sort)}
            data-testid="owner-users-sort"
            className="min-h-11 min-w-0 flex-1 rounded-lg border bg-background px-2 text-base"
          >
            {(['createdAt', 'name', 'email'] as const).map((option) => (
              <option key={option} value={option}>
                {t(('sort.' + option) as 'sort.createdAt' | 'sort.name' | 'sort.email')}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            data-testid="owner-users-direction"
            onClick={() => setDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
          >
            {direction === 'asc' ? t('ascending') : t('descending')}
          </Button>
        </div>
      </div>
      <p role="status" className="text-sm text-muted-foreground" data-testid="owner-users-count">
        {t('count', { count })}
      </p>
      {list.isPending ? (
        <div role="status" className="flex min-h-20 items-center gap-2 text-sm">
          <LoaderCircle className="size-5 animate-spin" />
          {t('loading')}
        </div>
      ) : list.isError ? (
        <div role="alert" className="space-y-2">
          <p className="break-words text-destructive">{t('error')}</p>
          <Button type="button" className="min-h-11" onClick={() => void list.refetch()}>
            {t('retry')}
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <p className="break-words text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="min-w-0 space-y-3" data-testid="owner-users-list">
          {entries.map((user) => (
            <Card key={user.id} data-testid={'owner-user-' + user.id} className="min-w-0">
              <CardContent className="min-w-0 space-y-3 p-4">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-semibold">{user.name || t('unnamed')}</p>
                    <p className="break-all text-sm text-muted-foreground">{user.email}</p>
                  </div>
                  {user.isOwner ? (
                    <Badge variant="secondary">
                      <ShieldCheck className="size-4" />
                      {t('owner')}
                    </Badge>
                  ) : (
                    <Badge variant={user.status === 'suspended' ? 'destructive' : 'outline'}>
                      {t(('status.' + user.status) as 'status.active' | 'status.suspended' | 'status.pending')}
                    </Badge>
                  )}
                </div>
                <p className="break-words text-xs text-muted-foreground">
                  {t('registered', { date: new Date(user.createdAt).toLocaleDateString(locale) })}
                </p>
                {!user.isOwner && (
                  <Button
                    type="button"
                    className="min-h-11 w-full whitespace-normal"
                    variant={user.status === 'suspended' ? 'outline' : 'destructive'}
                    data-testid={'owner-user-toggle-' + user.id}
                    disabled={approving || setSuspended.isPending}
                    onClick={() =>
                      setSelected({ id: user.id, name: user.name || user.email, suspend: user.status !== 'suspended' })
                    }
                  >
                    {user.status === 'suspended' ? t('unblock') : t('block')}
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
          {list.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full whitespace-normal"
              disabled={list.isFetchingNextPage}
              data-testid="owner-users-more"
              onClick={() => void list.fetchNextPage()}
            >
              {list.isFetchingNextPage ? t('loading') : t('more')}
            </Button>
          )}
        </div>
      )}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !approving && !setSuspended.isPending) setSelected(null);
        }}
      >
        <DialogContent
          className="min-w-0 max-w-[calc(100vw-2rem)] [overflow-wrap:anywhere]"
          data-testid="owner-users-confirm"
        >
          <DialogHeader className="min-w-0 pr-11">
            <DialogTitle>{selected?.suspend ? t('confirmBlock') : t('confirmUnblock')}</DialogTitle>
            <DialogDescription>
              {selected && t(selected.suspend ? 'blockDescription' : 'unblockDescription', { name: selected.name })}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Перед изменением статуса подтвердите действие с помощью Passkey владельца.
          </p>
          <DialogFooter className="flex min-w-0 flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={approving || setSuspended.isPending}
              data-testid="owner-users-cancel"
              onClick={() => setSelected(null)}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              className="min-h-11"
              variant={selected?.suspend ? 'destructive' : 'default'}
              disabled={approving || setSuspended.isPending || !selected}
              data-testid="owner-users-confirm-submit"
              onClick={() => void confirmWithPasskey()}
            >
              {approving || setSuspended.isPending ? t('loading') : selected?.suspend ? t('block') : t('unblock')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
