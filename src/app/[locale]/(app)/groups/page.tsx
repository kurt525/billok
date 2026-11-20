'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { Archive, ArchiveRestore, Plus, Search } from 'lucide-react';

const GROUPS_PER_PAGE = 12;

export default function GroupsPage() {
  return (
    <Suspense>
      <GroupsContent />
    </Suspense>
  );
}

function GroupsContent() {
  const t = useTranslations('groups');
  const searchParams = useSearchParams();
  const [showArchived, setShowArchived] = useState(searchParams.get('archived') === '1');
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);

  const groups = trpc.groups.list.useQuery();
  const archivedGroups = trpc.groups.listArchived.useQuery(undefined, { enabled: showArchived });
  const unarchive = trpc.groups.unarchive.useMutation({
    onSuccess: () => {
      groups.refetch();
      archivedGroups.refetch();
    },
  });

  const activeList = showArchived ? archivedGroups.data : groups.data;
  const isLoading = showArchived ? archivedGroups.isLoading : groups.isLoading;
  const hasGroups = (groups.data?.length ?? 0) > 0 || (archivedGroups.data?.length ?? 0) > 0;

  const filteredGroups = activeList?.filter((group) => group.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-6">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('list.subtitle')}</p>
        </div>
        <Button
          className="min-h-11 min-w-0 whitespace-normal"
          data-testid="mobile-groups-create"
          nativeButton={false}
          render={<Link href="/groups/new" />}
        >
          <Plus className="mr-2 h-4 w-4" />
          {t('list.newGroup')}
        </Button>
      </div>

      {hasGroups && (
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative min-w-0 w-full sm:flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t('list.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-11 min-w-0 scroll-mt-20 pl-9 text-base"
              data-testid="mobile-groups-search"
            />
          </div>
          <Button
            variant={showArchived ? 'default' : 'outline'}
            aria-pressed={showArchived}
            data-testid="mobile-groups-archived-toggle"
            size="sm"
            onClick={() => {
              setShowArchived(!showArchived);
              setShowAll(false);
            }}
            className="min-h-11 w-full min-w-0 whitespace-normal sm:w-auto sm:shrink-0"
          >
            <Archive className="mr-2 h-4 w-4" />
            {t('list.archived')}
          </Button>
        </div>
      )}

      {isLoading && <LoadingSpinner />}

      {!isLoading && activeList?.length === 0 && !search && (
        <Card>
          <CardContent className="py-12 text-center">
            {showArchived ? (
              <p className="text-muted-foreground">{t('list.noArchived')}</p>
            ) : (
              <>
                <p className="text-muted-foreground">{t('list.noGroups')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t('list.noGroupsDescription')}</p>
                <Button nativeButton={false} className="mt-4" render={<Link href="/groups/new" />}>
                  <Plus className="mr-2 h-4 w-4" />
                  {t('list.createFirst')}
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {hasGroups && filteredGroups?.length === 0 && search && (
        <p className="text-center text-muted-foreground">{t('list.noSearchResults')}</p>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-[repeat(auto-fit,minmax(280px,1fr))]">
        {(search || showAll ? filteredGroups : filteredGroups?.slice(0, GROUPS_PER_PAGE))?.map((group) => (
          <Link key={group.id} href={`/groups/${group.id}`} className="block min-w-0 scroll-mt-20">
            <Card
              className={`border-l-[3px] transition-all duration-200 hover:-translate-y-px hover:shadow-md ${
                showArchived
                  ? 'border-l-muted-foreground/40 border-dashed opacity-75'
                  : 'border-l-primary/60 hover:border-l-primary'
              }`}
            >
              <CardHeader className="pb-2">
                <CardTitle className="flex min-w-0 items-start gap-2.5 text-base">
                  <span className="text-2xl leading-none">{group.emoji}</span>
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{group.name}</span>
                  {showArchived && (
                    <Badge variant="outline" className="text-[10px] shrink-0">
                      <Archive className="mr-1 h-3 w-3" />
                      {t('list.archivedBadge')}
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {group.description && (
                  <p className="mb-1.5 min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                    {group.description}
                  </p>
                )}
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                    {t('list.memberCount', { count: group.members.length })}
                    {' · '}
                    {t('list.expenseCount', { count: group._count.expenses })}
                  </p>
                  {showArchived && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="min-h-11 whitespace-normal text-xs"
                      onClick={(e) => {
                        e.preventDefault();
                        unarchive.mutate({ groupId: group.id });
                      }}
                      disabled={unarchive.isPending}
                    >
                      <ArchiveRestore className="mr-1 h-3 w-3" />
                      {t('list.unarchive')}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {!search && !showAll && (filteredGroups?.length ?? 0) > GROUPS_PER_PAGE && (
        <div className="text-center">
          <Button variant="outline" size="sm" onClick={() => setShowAll(true)}>
            {t('list.showAll', { count: filteredGroups?.length ?? 0 })}
          </Button>
        </div>
      )}
    </div>
  );
}
