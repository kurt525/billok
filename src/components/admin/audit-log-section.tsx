'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, ScrollText } from 'lucide-react';

export function AuditLogSection() {
  const t = useTranslations('admin');
  const locale = useLocale();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const auditLog = trpc.admin.getAuditLog.useQuery({ limit: 20, cursor });
  const security = trpc.admin.getSecurityEvents.useQuery({ limit: 20 });

  const ACTION_LABELS: Record<string, { label: string; color: string }> = {
    USER_DELETED: { label: t('audit.actionUserDeleted'), color: 'bg-red-500/10 text-red-700 dark:text-red-400' },
    USER_SUSPENDED: {
      label: t('audit.actionUserSuspended'),
      color: 'bg-orange-500/10 text-orange-700 dark:text-orange-400',
    },
    USER_UNSUSPENDED: {
      label: t('audit.actionUserUnsuspended'),
      color: 'bg-green-500/10 text-green-700 dark:text-green-400',
    },
    GROUP_DELETED: { label: t('audit.actionGroupDeleted'), color: 'bg-red-500/10 text-red-700 dark:text-red-400' },
    IMPERSONATION_STARTED: {
      label: t('audit.actionImpersonation'),
      color: 'bg-purple-500/10 text-purple-700 dark:text-purple-400',
    },
    INVITE_CREATED: { label: t('audit.actionInviteCreated'), color: 'bg-blue-500/10 text-blue-700 dark:text-blue-400' },
    INVITE_REVOKED: {
      label: t('audit.actionInviteRevoked'),
      color: 'bg-orange-500/10 text-orange-700 dark:text-orange-400',
    },
    ANNOUNCEMENT_SET: {
      label: t('audit.actionAnnouncement'),
      color: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
    },
    REGISTRATION_MODE_CHANGED: {
      label: t('audit.actionRegModeChanged'),
      color: 'bg-violet-500/10 text-violet-700 dark:text-violet-400',
    },
    EXPORT_CREATED: { label: t('audit.actionExportCreated'), color: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-400' },
    TEST_EMAIL_SENT: { label: t('audit.actionTestEmail'), color: 'bg-teal-500/10 text-teal-700 dark:text-teal-400' },
    EXPIRED_SPLITS_CLEANED: {
      label: t('audit.actionSplitsCleaned'),
      color: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
    },
    UNUSED_RECEIPTS_CLEANED: {
      label: t('audit.actionUnusedReceiptsCleaned'),
      color: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
    },
  };

  function formatMetadata(metadata: Record<string, unknown> | null): string {
    if (!metadata) return '---';
    const parts: string[] = [];
    if (metadata.email) parts.push(`${metadata.email}`);
    if (metadata.name) parts.push(`"${metadata.name}"`);
    if (metadata.mode) parts.push(`mode: ${metadata.mode}`);
    if (typeof metadata.enabled === 'boolean') parts.push(`enabled: ${String(metadata.enabled)}`);
    if (metadata.code) parts.push(`code: ${metadata.code}`);
    if (metadata.targetEmail) parts.push(`${metadata.targetEmail}`);
    if (metadata.message !== undefined) {
      parts.push(metadata.message ? `"${String(metadata.message).slice(0, 50)}"` : '(cleared)');
    }
    if (metadata.deletedCount !== undefined) {
      parts.push(t('audit.filesDeleted', { count: metadata.deletedCount as number }));
    }
    if (metadata.to) parts.push(`to: ${metadata.to}`);
    if (metadata.provider) parts.push(`${metadata.provider}`);
    if (metadata.durationMs !== undefined) parts.push(`${metadata.durationMs}ms`);
    if (metadata.success === false && metadata.error) parts.push(`error: ${metadata.error}`);
    return parts.join(', ') || '---';
  }

  return (
    <section className="min-w-0" data-testid="admin-audit-section">
      <div className="mb-5 min-w-0 rounded-lg border p-3" data-testid="admin-security-events">
        <h3 className="mb-2 text-base font-semibold">События безопасности</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          Административные действия и отклонённые попытки. Идентификаторы объектов показаны только как отпечатки;
          секреты не сохраняются.
        </p>
        {security.isLoading ? (
          <p className="text-sm text-muted-foreground">Загрузка журнала…</p>
        ) : security.isError ? (
          <p className="text-sm text-destructive">Не удалось получить журнал безопасности.</p>
        ) : security.data?.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Событий пока нет.</p>
        ) : (
          <div className="max-h-72 space-y-2 overflow-y-auto" role="region" aria-label="События безопасности">
            {security.data?.items.map((entry) => (
              <div key={entry.id} className="min-w-0 rounded-md border px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={entry.outcome === 'DENIED' ? 'font-semibold text-destructive' : 'font-semibold'}>
                    {entry.outcome === 'DENIED' ? 'Отклонено' : 'Выполнено'}
                  </span>
                  <span className="[overflow-wrap:anywhere]">{entry.action}</span>
                </div>
                <p className="mt-1 text-muted-foreground [overflow-wrap:anywhere]">
                  {new Date(entry.createdAt).toLocaleString(locale)} · Субъект: {entry.actorId ?? 'не определён'}
                  {entry.targetFingerprint ? ' · Объект: ' + entry.targetFingerprint.slice(0, 16) : ''}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2">
        <ScrollText className="h-5 w-5 text-muted-foreground" />
        <h2 className="min-w-0 text-lg font-semibold [overflow-wrap:anywhere]">{t('audit.title')}</h2>
      </div>

      <Card className="min-w-0">
        <CardContent className="min-w-0 p-0">
          {auditLog.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : auditLog.data?.items.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">{t('audit.noEntries')}</div>
          ) : (
            <>
              <div
                className="min-w-0 max-w-full overflow-x-auto overscroll-x-contain"
                role="region"
                aria-label={t('audit.title')}
                tabIndex={0}
                data-testid="admin-audit-scroll"
              >
                <table className="w-full min-w-[720px] table-fixed text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="px-4 py-3 font-medium">{t('audit.colAction')}</th>
                      <th className="px-4 py-3 font-medium">{t('audit.colAdmin')}</th>
                      <th className="px-4 py-3 font-medium">{t('audit.colDetails')}</th>
                      <th className="px-4 py-3 font-medium">{t('audit.colTime')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLog.data?.items.map((entry) => {
                      const actionInfo = ACTION_LABELS[entry.action] ?? {
                        label: entry.action,
                        color: 'bg-gray-500/10 text-gray-700',
                      };
                      return (
                        <tr key={entry.id} className="border-b last:border-0">
                          <td className="px-4 py-3">
                            <Badge
                              variant="secondary"
                              className={actionInfo.color + ' max-w-full whitespace-normal [overflow-wrap:anywhere]'}
                            >
                              {actionInfo.label}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground [overflow-wrap:anywhere]">
                            {entry.adminName}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground [overflow-wrap:anywhere]">
                            {formatMetadata(entry.metadata)}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {new Date(entry.createdAt).toLocaleString(locale)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {auditLog.data?.nextCursor && (
                <div className="border-t px-4 py-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]"
                    data-testid="admin-audit-load-more"
                    onClick={() => setCursor(auditLog.data?.nextCursor)}
                  >
                    {t('audit.loadMore')}
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
