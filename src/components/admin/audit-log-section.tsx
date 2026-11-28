'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { normalizeSecurityActorUuid, securityActorPreview } from '@/lib/security-actor-uuid';
import {
  Bell,
  Copy,
  Filter,
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
type ActorAccount = { name: string | null; email: string; isOwner: boolean };
type DisplayEntry = JournalEntry & {
  actor: string;
  details: string[];
  outcome?: string;
  actorId?: string | null;
  account?: ActorAccount | null;
};

const touchButton = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]';

function SecurityActor({ entry, onFilter }: { entry: DisplayEntry; onFilter: (id: string) => void }) {
  const t = useTranslations('admin.audit');
  const [expanded, setExpanded] = useState(false);
  const id = entry.actorId;
  if (!id)
    return (
      <p className="text-xs text-muted-foreground" data-testid="journal-actor">
        {t('actorUnknownIdentity')}
      </p>
    );
  const account = entry.account;
  const uuid = normalizeSecurityActorUuid(id);
  return (
    <div className="min-w-0 space-y-1">
      {account ? (
        <>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{t('actorCurrentAccount')}</p>
          <p className="text-sm font-medium [overflow-wrap:anywhere]" data-testid="journal-actor">
            {account.name?.trim() || t('actorUnnamed')}
          </p>
          <p className="text-xs [overflow-wrap:anywhere]">{account.email}</p>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {t(account.isOwner ? 'actorOwner' : 'actorRegistered')}
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="journal-actor">
          {t('actorMissingAccount')}
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          className={touchButton + ' justify-start px-2 text-xs tabular-nums'}
          aria-label={t(expanded ? 'actorHideId' : 'actorShowId')}
          aria-expanded={expanded}
          data-testid="security-actor-toggle"
          onClick={() => setExpanded(!expanded)}
        >
          {t('actorIdPreview', { value: securityActorPreview(id) })}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-11"
          aria-label={t('actorCopyId')}
          title={t('actorCopyId')}
          data-testid="security-actor-copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(id);
              toast.success(t('actorCopySuccess'));
            } catch {
              toast.error(t('actorCopyFailed'));
            }
          }}
        >
          <Copy className="size-4" />
        </Button>
        {uuid && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-11"
            aria-label={t('actorFilterFromEntry')}
            title={t('actorFilterFromEntry')}
            data-testid="security-actor-filter"
            onClick={() => onFilter(uuid)}
          >
            <Filter className="size-4" />
          </Button>
        )}
      </div>
      {expanded && (
        <p className="min-w-0 text-xs font-mono [overflow-wrap:anywhere]" data-testid="security-actor-full-id">
          {id}
        </p>
      )}
    </div>
  );
}

function JournalList({
  entries,
  dates,
  security = false,
  onFilter,
}: {
  entries: DisplayEntry[];
  dates: AuditDateFormatter;
  security?: boolean;
  onFilter?: (id: string) => void;
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
                    {security && onFilter ? (
                      <SecurityActor entry={entry} onFilter={onFilter} />
                    ) : (
                      <p
                        className="text-xs leading-normal text-muted-foreground [overflow-wrap:anywhere]"
                        data-testid="journal-actor"
                      >
                        {entry.actor}
                      </p>
                    )}
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

function SecurityJournal({ dates }: { dates: AuditDateFormatter }) {
  const t = useTranslations('admin.audit');
  const client = useQueryClient();
  const [draft, setDraft] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  function inputFor(value: string | null) {
    return { limit: 20, ...(value ? { actorId: value } : {}) };
  }
  const security = trpc.admin.getSecurityEvents.useInfiniteQuery(inputFor(active), {
    getNextPageParam: (lastPage) => (active ? lastPage.nextCursor : undefined),
    retry: false,
  });
  function apply(value: string | null) {
    setDraft(value ?? '');
    setInvalid(false);
    if (value === active) return;
    // Inactive cached pages for the next filter must never be reused after a
    // filter switch. Requests for the old key can only affect the old cache.
    client.removeQueries({
      queryKey: getQueryKey(trpc.admin.getSecurityEvents, inputFor(value), 'infinite'),
      exact: true,
    });
    setActive(value);
  }
  const entries = (security.data?.pages.flatMap((page) => page.items) ?? []).map((entry) => ({
    ...entry,
    actor: '',
    account: entry.actor,
    details:
      entry.targetFingerprint && /^[a-f0-9]{64}$/u.test(entry.targetFingerprint)
        ? [t('objectFingerprint', { value: entry.targetFingerprint.slice(0, 16) })]
        : [],
  }));
  return (
    <div className="mb-5 min-w-0" data-testid="admin-security-events">
      <h2 className="mb-2 text-lg font-semibold [overflow-wrap:anywhere]">{t('securityTitle')}</h2>
      <p className="mb-3 text-xs leading-normal text-muted-foreground [overflow-wrap:anywhere]">
        {t('securityDescription')}
      </p>
      <form
        className="mb-3 min-w-0 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          const value = normalizeSecurityActorUuid(draft);
          if (!value) {
            setInvalid(true);
            return;
          }
          apply(value);
        }}
      >
        <label htmlFor="security-uuid-filter" className="text-sm font-medium">
          {t('uuidLabel')}
        </label>
        <Input
          id="security-uuid-filter"
          data-testid="security-uuid-input"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
          placeholder={t('uuidPlaceholder')}
          maxLength={128}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={invalid}
          aria-describedby={invalid ? 'security-uuid-error' : undefined}
          className="min-h-11 min-w-0 w-full text-base"
        />
        {invalid && (
          <p id="security-uuid-error" role="alert" className="text-sm text-destructive">
            {t('uuidInvalid')}
          </p>
        )}
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button type="submit" className={touchButton} data-testid="security-uuid-apply">
            {t('uuidApply')}
          </Button>
          <Button
            type="button"
            variant="outline"
            className={touchButton}
            data-testid="security-uuid-reset"
            onClick={() => apply(null)}
          >
            {t('uuidReset')}
          </Button>
        </div>
        {active && (
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="security-uuid-active">
            {t('uuidActive', { value: active })}
          </p>
        )}
      </form>
      <Card className="min-w-0">
        <CardContent className="min-w-0 p-0">
          {security.isLoading ? (
            <p className="px-3 py-4 text-sm text-muted-foreground" role="status">
              {t('loading')}
            </p>
          ) : security.isError && !security.data ? (
            <RetryState message={t('loadError')} retry={() => void security.refetch()} busy={security.isFetching} />
          ) : entries.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">{t(active ? 'uuidEmpty' : 'securityEmpty')}</p>
          ) : (
            <JournalList key={active ?? 'all'} entries={entries} dates={dates} security onFilter={apply} />
          )}
          {security.data && security.isFetchNextPageError && (
            <p className="px-3 pt-3 text-sm text-destructive [overflow-wrap:anywhere]" role="alert">
              {t('moreError')}
            </p>
          )}
          {security.data && security.isRefetchError && !security.isFetchNextPageError && (
            <RetryState message={t('refreshError')} retry={() => void security.refetch()} busy={security.isFetching} />
          )}
          {active && security.hasNextPage && (
            <div className="border-t px-3 py-2">
              <Button
                type="button"
                variant="ghost"
                className={touchButton + ' w-full'}
                data-testid="admin-security-load-more"
                disabled={security.isFetching}
                onClick={() => void security.fetchNextPage({ cancelRefetch: false })}
              >
                {t(security.isFetchingNextPage ? 'loadingMore' : security.isFetchNextPageError ? 'retry' : 'loadMore')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
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
  const auditEntries = (auditLog.data?.pages.flatMap((page) => page.items) ?? []).map((entry) => ({
    ...entry,
    actor: t('administrator', { value: entry.adminName }),
    details: auditDetails(entry.action, entry.metadata, t, dates),
  }));
  return (
    <section className="min-w-0" data-testid="admin-audit-section">
      <SecurityJournal dates={dates} />
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
