'use client';

import { useTranslations } from 'next-intl';

export type ReceiptTab = 'people' | 'items' | 'links';

// Panels remain mounted when hidden. Pending requests and unsaved editor
// drafts must survive tab changes, including switches during an SSE update.
export function ReceiptTabs({
  activeTab,
  onSelect,
  peopleCount,
  itemCount,
  finalized = false,
}: {
  activeTab: ReceiptTab;
  onSelect: (tab: ReceiptTab) => void;
  peopleCount: number;
  itemCount: number;
  finalized?: boolean;
}) {
  const t = useTranslations('split.claim');
  const tabs: { id: ReceiptTab; label: string; count?: number | undefined }[] = [
    ...(finalized ? [] : [{ id: 'people' as const, label: t('tabsPeople'), count: peopleCount }]),
    { id: 'items', label: t(finalized ? 'tabsSummary' : 'tabsItems'), count: finalized ? undefined : itemCount },
    { id: 'links', label: t('tabsLinks') },
  ];

  return (
    <div
      role="tablist"
      aria-label={t('tabsLabel')}
      className={'grid min-w-0 gap-1 rounded-xl border bg-muted/40 p-1 ' + (finalized ? 'grid-cols-2' : 'grid-cols-3')}
      data-testid="claim-receipt-tabs"
    >
      {tabs.map(({ id, label, count }) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={'claim-' + id + '-tab'}
          aria-controls={'claim-' + id + '-panel'}
          aria-selected={activeTab === id}
          tabIndex={activeTab === id ? 0 : -1}
          data-testid={'claim-tab-' + id}
          className={
            'flex min-h-12 min-w-0 flex-wrap items-center justify-center gap-1 rounded-lg px-1 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ' +
            (activeTab === id
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-background/70')
          }
          onClick={() => onSelect(id)}
          onKeyDown={(event) => {
            const index = tabs.findIndex((tab) => tab.id === id);
            const nextIndex =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : event.key === 'ArrowLeft'
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === 'ArrowRight'
                      ? (index + 1) % tabs.length
                      : -1;
            const next = tabs[nextIndex]?.id;
            if (!next) return;
            event.preventDefault();
            onSelect(next);
            event.currentTarget.parentElement
              ?.querySelector<HTMLButtonElement>('[data-testid="claim-tab-' + next + '"]')
              ?.focus();
          }}
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
          {count !== undefined && (
            <span className="shrink-0 rounded-md border bg-muted px-1 text-xs tabular-nums" aria-hidden="true">
              {count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
