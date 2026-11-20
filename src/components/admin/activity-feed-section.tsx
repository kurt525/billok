'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Activity } from 'lucide-react';

export function ActivityFeedSection() {
  const t = useTranslations('admin');
  const locale = useLocale();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const activity = trpc.admin.getGlobalActivity.useQuery({
    limit: 20,
    cursor,
  });

  const TYPE_LABELS: Record<string, string> = {
    EXPENSE_CREATED: t('activity.typeExpenseCreated'),
    EXPENSE_UPDATED: t('activity.typeExpenseUpdated'),
    EXPENSE_DELETED: t('activity.typeExpenseDeleted'),
    SETTLEMENT_CREATED: t('activity.typeSettlementCreated'),
    SETTLEMENT_DELETED: t('activity.typeSettlementDeleted'),
    MEMBER_JOINED: t('activity.typeMemberJoined'),
    MEMBER_LEFT: t('activity.typeMemberLeft'),
    GROUP_UPDATED: t('activity.typeGroupUpdated'),
    PLACEHOLDER_CREATED: t('activity.typePlaceholderCreated'),
    PLACEHOLDER_MERGED: t('activity.typePlaceholderMerged'),
    GROUP_ARCHIVED: t('activity.typeGroupArchived'),
    GROUP_UNARCHIVED: t('activity.typeGroupUnarchived'),
    OWNERSHIP_TRANSFERRED: t('activity.typeOwnershipTransferred'),
  };

  return (
    <section className="min-w-0" data-testid="admin-activity-section">
      <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2">
        <Activity className="h-5 w-5 text-muted-foreground" />
        <h2 className="min-w-0 text-lg font-semibold [overflow-wrap:anywhere]">{t('activity.title')}</h2>
      </div>

      <Card className="min-w-0">
        <CardContent className="min-w-0 p-0">
          {activity.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : activity.data?.items.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">{t('activity.noActivity')}</div>
          ) : (
            <>
              <div
                className="min-w-0 max-w-full overflow-x-auto overscroll-x-contain"
                role="region"
                aria-label={t('activity.title')}
                tabIndex={0}
                data-testid="admin-activity-scroll"
              >
                <table className="w-full min-w-[720px] table-fixed text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="px-4 py-3 font-medium">{t('activity.colType')}</th>
                      <th className="px-4 py-3 font-medium">{t('activity.colUser')}</th>
                      <th className="px-4 py-3 font-medium">{t('activity.colGroup')}</th>
                      <th className="px-4 py-3 font-medium">{t('activity.colTime')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.data?.items.map((item) => (
                      <tr key={item.id} className="border-b last:border-0">
                        <td className="px-4 py-3">
                          <Badge variant="outline" className="max-w-full whitespace-normal [overflow-wrap:anywhere]">
                            {TYPE_LABELS[item.type] ?? item.type}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground [overflow-wrap:anywhere]">{item.userName}</td>
                        <td className="px-4 py-3 text-muted-foreground [overflow-wrap:anywhere]">{item.groupName}</td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {new Date(item.createdAt).toLocaleString(locale)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {activity.data?.nextCursor && (
                <div className="border-t px-4 py-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]"
                    data-testid="admin-activity-load-more"
                    onClick={() => setCursor(activity.data?.nextCursor)}
                  >
                    {t('activity.loadMore')}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
