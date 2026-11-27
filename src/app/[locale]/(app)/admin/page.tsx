'use client';

import { useState } from 'react';

import { useSession } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Shield, Package, Clock, Loader2, RefreshCw, ReceiptText, Users } from 'lucide-react';

import { AuditLogSection } from '@/components/admin/audit-log-section';
import { RegistrationControlSection } from '@/components/admin/registration-control-section';
import { AnnouncementSection } from '@/components/admin/announcement-section';
import { ToolsSection } from '@/components/admin/tools-section';
import { ServerLogsSection } from '@/components/admin/server-logs-section';
import { UserManagementSection } from '@/components/admin/user-management-section';
import { GroupOverviewSection } from '@/components/admin/group-overview-section';
import { localizedTrpcError } from '@/lib/localized-trpc-error';

export default function AdminPage() {
  const { data: session } = useSession();
  const t = useTranslations('admin');
  const currentUserEmail = session?.user?.email;

  return (
    <div className="min-w-0 space-y-6">
      <div className="flex items-center gap-3">
        <Shield className="h-7 w-7 text-primary" />
        <h1 className="text-2xl font-bold">{t('title')}</h1>
      </div>

      <div className="grid gap-6 [&>*]:min-w-0">
        <SystemHealthSection />
        <UserManagementEntry {...(currentUserEmail !== undefined ? { currentUserEmail } : {})} />
        <Separator />
        <GroupOverviewSection />
        <Separator />
        <StorageStatsSection />
        <Separator />
        <RegistrationControlSection />
        <Separator />
        <AnnouncementSection />
        <Separator />
        <ToolsSection />
        <Separator />
        <ServerLogsSection />
        <Separator />
        <AuditLogSection />
      </div>
    </div>
  );
}

// The additional owner-only page checks OwnerBootstrap both at render and
// in its tRPC routes. Never decide ownership from the email in this link.
function UserManagementEntry({ currentUserEmail }: { currentUserEmail?: string | null }) {
  const t = useTranslations('admin.ownerUsers');
  const access = trpc.admin.ownerRegisteredUsers.useQuery(
    {
      limit: 1,
      status: 'all',
      sortBy: 'createdAt',
      sortDirection: 'desc',
    },
    { retry: false, staleTime: 60_000 },
  );
  // New owner panel remains separate. Preserve the legacy administrator
  // section until security hardening in 6.12, without duplicating it for owner.
  if (access.isPending) return null;
  if (!access.isSuccess)
    return <UserManagementSection {...(currentUserEmail !== undefined ? { currentUserEmail } : {})} />;
  return (
    <Link
      href="/admin/users"
      data-testid="owner-users-nav"
      className="flex min-h-11 min-w-0 items-center gap-2 rounded-xl border p-3 text-sm font-medium text-primary"
    >
      <Users className="size-5 shrink-0" />
      <span className="min-w-0 break-words">{t('navTitle')}</span>
    </Link>
  );
}

// ─── System Health ─────────────────────────────────────────

function SystemHealthSection() {
  const t = useTranslations('admin');
  const locale = useLocale();
  const health = trpc.admin.getSystemHealth.useQuery(undefined, {
    refetchInterval: 30000,
  });

  if (health.isLoading) return <SectionSkeleton title={t('systemHealth.title')} />;

  const data = health.data;

  return (
    <section className="min-w-0" data-testid="admin-system-health">
      <h2 className="mb-4 min-w-0 text-lg font-semibold [overflow-wrap:anywhere]">{t('systemHealth.title')}</h2>
      <div className="grid min-w-0 gap-4 @2xl:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Package className="h-4 w-4" />
              {t('systemHealth.version')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span
              className="block min-w-0 text-sm font-medium [overflow-wrap:anywhere]"
              data-testid="admin-system-version"
            >
              {data?.version ? 'v' + data.version : t('systemHealth.notAvailable')}
            </span>
            {data?.commitSha && data.commitSha !== 'unknown' && (
              <span
                className="block min-w-0 break-all font-mono text-xs text-muted-foreground"
                data-testid="admin-system-commit"
              >
                ({data.commitSha})
              </span>
            )}
            <dl className="mt-3 min-w-0 space-y-3 text-sm [overflow-wrap:anywhere]">
              <div>
                <dt className="text-xs text-muted-foreground">{t('systemHealth.releaseTask')}</dt>
                <dd data-testid="admin-system-release-task">
                  {data?.release ? (
                    <>
                      <span className="block font-medium">{data.release.taskId}</span>
                      <span className="block">{data.release.taskTitle}</span>
                    </>
                  ) : (
                    t('systemHealth.notAvailable')
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('systemHealth.pullRequest')}</dt>
                <dd data-testid="admin-system-release-pr">
                  {data?.release ? (
                    <a
                      className="inline-flex min-h-11 items-center text-primary underline [overflow-wrap:anywhere]"
                      href={`https://github.com/kurt525/billok/pull/${data.release.pullRequest}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      #{data.release.pullRequest}
                    </a>
                  ) : (
                    t('systemHealth.notAvailable')
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('systemHealth.deployedAt')}</dt>
                <dd data-testid="admin-system-deployed-at">
                  {data?.deployedAt
                    ? new Date(data.deployedAt).toLocaleString(locale, {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        timeZoneName: 'short',
                      })
                    : t('systemHealth.notAvailable')}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Clock className="h-4 w-4" />
              {t('systemHealth.uptime')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-sm font-medium">{data ? formatUptime(data.uptime) : '---'}</span>
            {data?.serverStartTime && (
              <p className="mt-1 min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {t('systemHealth.started', { time: new Date(data.serverStartTime).toLocaleString(locale) })}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

// ─── Storage Stats ─────────────────────────────────────────

function StorageStatsSection() {
  const t = useTranslations('admin');
  const tc = useTranslations('common');
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const storage = trpc.admin.getStorageStats.useQuery(undefined, { refetchOnMount: 'always' });
  const utils = trpc.useUtils();
  const cleanupUnused = trpc.admin.cleanupUnusedReceipts.useMutation({
    onSuccess: () => {
      utils.admin.getStorageStats.invalidate();
      utils.admin.getAuditLog.invalidate();
      setCleanupOpen(false);
    },
  });

  if (storage.isLoading) return <SectionSkeleton title={t('storage.title')} />;
  if (storage.isError || !storage.data) {
    return (
      <section className="min-w-0" data-testid="admin-storage-stats">
        <h2 className="mb-4 text-lg font-semibold">{t('storage.title')}</h2>
        <Card>
          <CardContent className="space-y-3">
            <p role="alert" className="text-sm text-destructive">
              {t('storage.loadError')}
            </p>
            <Button
              variant="outline"
              className="min-h-11 whitespace-normal"
              disabled={storage.isFetching}
              onClick={() => void storage.refetch()}
              data-testid="admin-storage-retry"
            >
              {t('storage.retry')}
            </Button>
          </CardContent>
        </Card>
      </section>
    );
  }
  const data = storage.data;
  return (
    <section className="min-w-0" data-testid="admin-storage-stats">
      <h2 className="mb-4 min-w-0 text-lg font-semibold [overflow-wrap:anywhere]">{t('storage.title')}</h2>
      <div className="grid min-w-0 gap-4 @2xl:grid-cols-2 [&>*]:min-w-0">
        {(
          [
            ['total', 'receipts', data.receiptCount],
            ['claiming', 'claiming', data.claimingCount],
            ['finalized', 'finalized', data.finalizedCount],
          ] as const
        ).map(([id, label, count]) => (
          <Card key={id} data-testid={`admin-receipt-count-${id}`}>
            <CardHeader className="pb-2">
              <CardTitle className="flex min-w-0 items-center gap-2 text-sm font-medium text-muted-foreground [overflow-wrap:anywhere]">
                <ReceiptText className="h-4 w-4 shrink-0" />
                {t(`storage.${label}`)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="min-w-0 text-2xl font-bold [overflow-wrap:anywhere]">{count}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <h3 className="mb-3 mt-6 text-base font-semibold">{t('storage.technicalTitle')}</h3>
      <div className="grid min-w-0 gap-4">
        <Card data-testid="unused-receipts-card">
          <CardHeader className="pb-2">
            <CardTitle className="flex min-w-0 flex-wrap items-center justify-between gap-2 [overflow-wrap:anywhere]">
              <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium text-muted-foreground [overflow-wrap:anywhere]">
                <ReceiptText className="h-4 w-4" />
                {t('storage.unusedReceipts')}
              </span>
              {data.unusedReceiptCount > 0 && (
                <Button
                  size="sm"
                  variant="destructive"
                  className="min-h-11 min-w-11 whitespace-normal leading-tight"
                  data-testid="admin-storage-open-cleanup"
                  onClick={() => setCleanupOpen(true)}
                  disabled={cleanupUnused.isPending}
                >
                  {cleanupUnused.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  {t('storage.cleanUp')}
                </Button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="min-w-0 text-2xl font-bold [overflow-wrap:anywhere]">{data.unusedReceiptCount}</p>
            <p className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {t('storage.unusedDescription')}
            </p>
            {cleanupUnused.isSuccess && (
              <p className="mt-2 text-sm text-green-600">
                {t('storage.unusedCleanedUp', { count: cleanupUnused.data.deletedCount })}
              </p>
            )}
            {cleanupUnused.isError && (
              <p className="mt-2 text-sm text-destructive">
                {localizedTrpcError(cleanupUnused.error, tc('errors.generic'))}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
      <Dialog
        open={cleanupOpen}
        onOpenChange={(open) => {
          if (!open && !cleanupUnused.isPending) setCleanupOpen(false);
        }}
      >
        <DialogContent
          data-testid="admin-storage-cleanup-dialog"
          className="min-w-0 overflow-x-hidden [overflow-wrap:anywhere] [&_[data-slot=dialog-close]]:min-h-11 [&_[data-slot=dialog-close]]:min-w-11"
        >
          <DialogHeader className="min-w-0 pr-11">
            <DialogTitle className="[overflow-wrap:anywhere]">{t('storage.confirmUnusedTitle')}</DialogTitle>
            <DialogDescription className="[overflow-wrap:anywhere]">
              {t('storage.confirmUnusedDescription', { count: data.unusedReceiptCount })}
            </DialogDescription>
          </DialogHeader>
          {cleanupUnused.isError && (
            <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
              {localizedTrpcError(cleanupUnused.error, tc('errors.generic'))}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11 min-w-11"
              data-testid="admin-storage-cleanup-cancel"
              disabled={cleanupUnused.isPending}
              onClick={() => setCleanupOpen(false)}
            >
              {t('storage.cancel')}
            </Button>
            <Button
              variant="destructive"
              className="min-h-11 min-w-11"
              data-testid="admin-storage-cleanup-confirm"
              disabled={cleanupUnused.isPending || data.unusedReceiptCount === 0}
              onClick={() => {
                if (data.unusedReceiptCount > 0) cleanupUnused.mutate();
              }}
            >
              {cleanupUnused.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('storage.cleanUp')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ─── Helpers ───────────────────────────────────────────────

function SectionSkeleton({ title }: { title: string }) {
  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    </section>
  );
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);

  return parts.join(' ');
}
