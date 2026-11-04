'use client';

import { useState, useEffect } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { formatCents } from '@/lib/money';
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
import { Trash2, Loader2, Search, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';

type GroupSortBy = 'name' | 'memberCount' | 'expenseCount' | 'createdAt';
type GroupStatus = 'all' | 'active' | 'archived';
type SortDirection = 'asc' | 'desc';

function SortIcon({
  column,
  currentSort,
  currentDirection,
}: {
  column: GroupSortBy;
  currentSort: GroupSortBy;
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

export function GroupOverviewSection() {
  const t = useTranslations('admin');
  const utils = trpc.useUtils();
  const locale = useLocale();

  // Filter / search / sort state
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState<GroupStatus>('all');
  const [sortBy, setSortBy] = useState<GroupSortBy>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  // Debounce search input (300ms)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Infinite query with cursor pagination
  const groups = trpc.admin.listGroups.useInfiniteQuery(
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

  const allGroups = groups.data?.pages.flatMap((p) => p.groups) ?? [];
  const totalCount = groups.data?.pages[0]?.totalCount ?? 0;
  const totalExpenses = groups.data?.pages[0]?.totalExpenses;
  const totalSettlements = groups.data?.pages[0]?.totalSettlements;

  // Mutations
  const deleteGroup = trpc.admin.deleteGroup.useMutation({
    onSuccess: () => {
      utils.admin.listGroups.invalidate();
      utils.admin.getAuditLog.invalidate();
      setDeleteTarget(null);
    },
  });

  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const handleSort = (column: GroupSortBy) => {
    if (sortBy === column) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(column);
      setSortDirection('asc');
    }
  };

  const statuses: { value: GroupStatus; label: string }[] = [
    { value: 'all', label: t('groups.filterAll') },
    { value: 'active', label: t('groups.filterActive') },
    { value: 'archived', label: t('groups.filterArchived') },
  ];

  return (
    <section className="min-w-0" data-testid="admin-groups-section">
      <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 className="min-w-0 text-lg font-semibold [overflow-wrap:anywhere]">{t('groups.title')}</h2>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant="secondary">{t('groups.count', { count: totalCount })}</Badge>
          {totalExpenses != null && <Badge variant="secondary">{t('groups.expenses', { count: totalExpenses })}</Badge>}
          {totalSettlements != null && (
            <Badge variant="secondary">{t('groups.settlements', { count: totalSettlements })}</Badge>
          )}
        </div>
      </div>

      {/* Filters toolbar */}
      <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
        {/* Status filter buttons */}
        <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label={t('groups.title')}>
          {statuses.map((s) => (
            <Button
              key={s.value}
              size="sm"
              variant={status === s.value ? 'default' : 'outline'}
              data-testid={'admin-groups-filter-' + s.value}
              aria-pressed={status === s.value}
              onClick={() => setStatus(s.value)}
              className="min-h-11 min-w-11 max-w-full whitespace-normal px-3 py-2 text-xs [overflow-wrap:anywhere]"
            >
              {s.label}
            </Button>
          ))}
        </div>

        {/* Search */}
        <div className="relative min-w-0 basis-full flex-1 sm:min-w-[180px] sm:basis-auto">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            data-testid="admin-groups-search"
            aria-label={t('groups.searchAriaLabel')}
            placeholder={t('groups.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-h-11 w-full min-w-0 max-w-full pl-8 text-base"
          />
        </div>
      </div>

      <Card className="min-w-0">
        <CardContent className="min-w-0 p-0">
          {groups.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : groups.isError ? (
            <div className="flex flex-col items-center gap-2 py-12 text-sm text-destructive">
              <p>{t('groups.errorLoading')}</p>
              <Button variant="outline" size="sm" onClick={() => groups.refetch()}>
                {t('groups.retry')}
              </Button>
            </div>
          ) : allGroups.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">{t('groups.noGroups')}</div>
          ) : (
            <>
              <div
                className="min-w-0 max-w-full overflow-x-auto overscroll-x-contain"
                role="region"
                aria-label={t('groups.title')}
                tabIndex={0}
                data-testid="admin-groups-scroll"
              >
                <table className="w-full min-w-[820px] table-fixed text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th
                        className="px-4 py-3 font-medium"
                        aria-sort={sortBy === 'name' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                      >
                        <button
                          type="button"
                          className="inline-flex min-h-11 min-w-11 flex-wrap items-center gap-1 whitespace-normal [overflow-wrap:anywhere] hover:text-foreground"
                          data-testid="admin-groups-sort-name"
                          onClick={() => handleSort('name')}
                        >
                          {t('groups.colName')}
                          <SortIcon column="name" currentSort={sortBy} currentDirection={sortDirection} />
                        </button>
                      </th>
                      <th
                        className="px-4 py-3 font-medium text-right"
                        aria-sort={
                          sortBy === 'memberCount' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'
                        }
                      >
                        <button
                          type="button"
                          className="inline-flex min-h-11 min-w-11 flex-wrap items-center gap-1 whitespace-normal [overflow-wrap:anywhere] hover:text-foreground"
                          data-testid="admin-groups-sort-memberCount"
                          onClick={() => handleSort('memberCount')}
                        >
                          {t('groups.colMembers')}
                          <SortIcon column="memberCount" currentSort={sortBy} currentDirection={sortDirection} />
                        </button>
                      </th>
                      <th
                        className="px-4 py-3 font-medium text-right"
                        aria-sort={
                          sortBy === 'expenseCount' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'
                        }
                      >
                        <button
                          type="button"
                          className="inline-flex min-h-11 min-w-11 flex-wrap items-center gap-1 whitespace-normal [overflow-wrap:anywhere] hover:text-foreground"
                          data-testid="admin-groups-sort-expenseCount"
                          onClick={() => handleSort('expenseCount')}
                        >
                          {t('groups.colExpenses')}
                          <SortIcon column="expenseCount" currentSort={sortBy} currentDirection={sortDirection} />
                        </button>
                      </th>
                      <th className="px-4 py-3 font-medium text-right">{t('groups.colTotal')}</th>
                      <th className="px-4 py-3 font-medium">{t('groups.colLastActivity')}</th>
                      <th className="px-4 py-3 font-medium">{t('groups.colStatus')}</th>
                      <th className="px-4 py-3 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {allGroups.map((group) => (
                      <tr key={group.id} className="border-b last:border-0">
                        <td className="px-4 py-3 font-medium [overflow-wrap:anywhere]">{group.name}</td>
                        <td className="px-4 py-3 text-right">{group.memberCount}</td>
                        <td className="px-4 py-3 text-right">{group.expenseCount}</td>
                        <td className="px-4 py-3 text-right">
                          {group.totalAmount == null ? (
                            <span title={t('groups.totalUnavailable')}>—</span>
                          ) : (
                            formatCents(group.totalAmount, group.currency, locale)
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {new Date(group.lastActivity).toLocaleDateString(locale)}
                        </td>
                        <td className="px-4 py-3">
                          {group.isArchived ? (
                            <Badge variant="outline">{t('groups.statusArchived')}</Badge>
                          ) : (
                            <Badge variant="secondary">{t('groups.statusActive')}</Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('groups.deleteGroup', { name: group.name })}
                            onClick={() =>
                              setDeleteTarget({
                                id: group.id,
                                name: group.name,
                              })
                            }
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {groups.hasNextPage && (
                <div className="border-t px-4 py-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]"
                    data-testid="admin-groups-load-more"
                    onClick={() => groups.fetchNextPage()}
                    disabled={groups.isFetchingNextPage}
                  >
                    {groups.isFetchingNextPage && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('groups.loadMore')}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('groups.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t.rich('groups.deleteDescription', {
                name: deleteTarget?.name ?? '',
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteGroup.isPending}>
              {t('groups.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteGroup.mutate({ groupId: deleteTarget.id })}
              disabled={deleteGroup.isPending}
            >
              {deleteGroup.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('groups.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
