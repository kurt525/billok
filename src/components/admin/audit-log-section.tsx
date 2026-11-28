'use client';

import { useLocale, useTranslations } from 'next-intl';
import {
  Bell,
  FileDown,
  KeyRound,
  Mail,
  ScrollText,
  ShieldCheck,
  Ticket,
  Trash2,
  UserRound,
  Users,
  UserRoundPlus,
  type LucideIcon,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  actionPresentation,
  auditDetails,
  auditTime,
  createAuditDateFormatter,
  groupAuditEntries,
  type AuditDateFormatter,
} from './audit-log-format';

const icons: Record<ReturnType<typeof actionPresentation>['category'], LucideIcon> = {
  user: UserRound,
  group: Users,
  key: KeyRound,
  invite: Ticket,
  registration: UserRoundPlus,
  mail: Mail,
  file: FileDown,
  message: Bell,
  cleanup: Trash2,
  security: ShieldCheck,
};

type JournalEntry = {
  id: string;
  action: string;
  createdAt: Date | string;
};
type DisplayEntry = JournalEntry & { actor: string; details: string[]; outcome?: string };

function JournalList({
  entries,
  dates,
  security = false,
}: {
  entries: DisplayEntry[];
  dates: AuditDateFormatter;
  security?: boolean;
}) {
  const t = useTranslations('admin.audit');
  const groups = groupAuditEntries(entries, dates, t('unknownDate'));
  return (
    <div className="min-w-0 max-w-full" data-testid={security ? 'admin-security-list' : 'admin-audit-list'}>
      {groups.map((group) => (
        <div key={group.date} className="min-w-0 border-b last:border-b-0">
          <h3
            className="bg-muted/40 px-3 py-2 text-sm font-medium text-muted-foreground [overflow-wrap:anywhere]"
            data-testid="journal-date"
          >
            {group.date}
          </h3>
          <ul className="divide-y">
            {group.items.map((entry) => {
              const info = actionPresentation(entry.action, security);
              const Icon = icons[info.category];
              const denied = entry.outcome === 'DENIED';
              const caution = denied || (!security && info.caution);
              const time = auditTime(entry.createdAt, dates);
              return (
                <li
                  key={entry.id}
                  className="flex min-w-0 items-start gap-2.5 px-3 py-3"
                  data-testid="journal-entry"
                  data-entry-id={entry.id}
                >
                  <span
                    className={
                      'flex size-8 shrink-0 items-center justify-center rounded-lg ' +
                      (caution ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground')
                    }
                    aria-hidden="true"
                  >
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p
                      className="text-sm leading-snug font-semibold [overflow-wrap:anywhere]"
                      data-testid="journal-action"
                    >
                      {t(info.key)}
                    </p>
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs leading-normal text-muted-foreground">
                      {time ? (
                        <time className="tabular-nums" dateTime={time.iso} data-testid="journal-time">
                          {time.text}
                        </time>
                      ) : (
                        <span>{t('unknownTime')}</span>
                      )}
                      {security && (
                        <span className={denied ? 'font-semibold text-destructive' : 'font-medium'}>
                          {t(
                            entry.outcome === 'DENIED'
                              ? 'outcomeDenied'
                              : entry.outcome === 'ALLOWED'
                                ? 'outcomeAllowed'
                                : 'outcomeUnknown',
                          )}
                        </span>
                      )}
                    </div>
                    <p
                      className="text-xs leading-normal text-muted-foreground [overflow-wrap:anywhere]"
                      data-testid="journal-actor"
                    >
                      {entry.actor}
                    </p>
                    {entry.details.length > 0 && (
                      <div
                        className="space-y-0.5 text-xs leading-normal [overflow-wrap:anywhere]"
                        data-testid="journal-details"
                      >
                        {entry.details.map((detail, index) => (
                          <p key={index}>{detail}</p>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function RetryState({ message, retry, busy }: { message: string; retry: () => void; busy: boolean }) {
  const t = useTranslations('admin.audit');
  return (
    <div className="space-y-2 px-3 py-3" role="alert">
      <p className="text-sm text-destructive [overflow-wrap:anywhere]">{message}</p>
      <Button
        variant="outline"
        className="min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]"
        disabled={busy}
        onClick={retry}
      >
        {t('retry')}
      </Button>
    </div>
  );
}

export function AuditLogSection() {
  const t = useTranslations('admin.audit');
  const locale = useLocale();
  const dates = createAuditDateFormatter(locale);
  const auditLog = trpc.admin.getAuditLog.useInfiniteQuery(
    { limit: 20 },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      retry: false,
    },
  );
  const security = trpc.admin.getSecurityEvents.useQuery({ limit: 20 }, { retry: false });
  const auditEntries = (auditLog.data?.pages.flatMap((page) => page.items) ?? []).map((entry) => ({
    ...entry,
    actor: t('administrator', { value: entry.adminName }),
    details: auditDetails(entry.action, entry.metadata, t, dates),
  }));
  const securityEntries = (security.data?.items ?? []).map((entry) => ({
    ...entry,
    actor: entry.actorId ? t('actor', { value: entry.actorId }) : t('unknownActor'),
    details:
      entry.targetFingerprint && /^[a-f0-9]{64}$/u.test(entry.targetFingerprint)
        ? [t('objectFingerprint', { value: entry.targetFingerprint.slice(0, 16) })]
        : [],
  }));
  return (
    <section className="min-w-0" data-testid="admin-audit-section">
      <div className="mb-5 min-w-0" data-testid="admin-security-events">
        <h2 className="mb-2 text-lg font-semibold [overflow-wrap:anywhere]">{t('securityTitle')}</h2>
        <p className="mb-3 text-xs leading-normal text-muted-foreground [overflow-wrap:anywhere]">
          {t('securityDescription')}
        </p>
        <Card className="min-w-0">
          <CardContent className="min-w-0 p-0">
            {security.isLoading ? (
              <p className="px-3 py-4 text-sm text-muted-foreground" role="status">
                {t('loading')}
              </p>
            ) : security.isError && !security.data ? (
              <RetryState message={t('loadError')} retry={() => void security.refetch()} busy={security.isFetching} />
            ) : securityEntries.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">{t('securityEmpty')}</p>
            ) : (
              <JournalList entries={securityEntries} dates={dates} security />
            )}
            {security.isError && security.data && (
              <RetryState
                message={t('refreshError')}
                retry={() => void security.refetch()}
                busy={security.isFetching}
              />
            )}
          </CardContent>
        </Card>
      </div>
      <div className="mb-3 flex min-w-0 items-center gap-2">
        <ScrollText className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2 className="min-w-0 text-lg font-semibold [overflow-wrap:anywhere]">{t('title')}</h2>
      </div>
      <Card className="min-w-0">
        <CardContent className="min-w-0 p-0">
          {auditLog.isLoading ? (
            <p className="px-3 py-4 text-sm text-muted-foreground" role="status">
              {t('loading')}
            </p>
          ) : auditLog.isError && !auditLog.data ? (
            <RetryState message={t('loadError')} retry={() => void auditLog.refetch()} busy={auditLog.isFetching} />
          ) : auditEntries.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">{t('noEntries')}</p>
          ) : (
            <JournalList entries={auditEntries} dates={dates} />
          )}
          {auditLog.data && auditLog.isFetchNextPageError && (
            <p className="px-3 pt-3 text-sm text-destructive [overflow-wrap:anywhere]" role="alert">
              {t('moreError')}
            </p>
          )}
          {auditLog.data && auditLog.isRefetchError && !auditLog.isFetchNextPageError && (
            <RetryState message={t('refreshError')} retry={() => void auditLog.refetch()} busy={auditLog.isFetching} />
          )}
          {auditLog.hasNextPage && (
            <div className="border-t px-3 py-2">
              <Button
                variant="ghost"
                className="min-h-11 w-full min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]"
                data-testid="admin-audit-load-more"
                disabled={auditLog.isFetching}
                onClick={() => void auditLog.fetchNextPage({ cancelRefetch: false })}
              >
                {t(auditLog.isFetchingNextPage ? 'loadingMore' : auditLog.isFetchNextPageError ? 'retry' : 'loadMore')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
