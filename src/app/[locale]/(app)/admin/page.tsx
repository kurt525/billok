'use client';

import { useState } from 'react';

import { useSession } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
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
import {
  Shield,
  Database,
  Package,
  Clock,
  FolderOpen,
  HardDrive,
  FileWarning,
  Loader2,
  RefreshCw,
  ReceiptText,
} from 'lucide-react';

import { AuditLogSection } from '@/components/admin/audit-log-section';
import { RegistrationControlSection } from '@/components/admin/registration-control-section';
import { AnnouncementSection } from '@/components/admin/announcement-section';
import { ActivityFeedSection } from '@/components/admin/activity-feed-section';
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
        <Separator />
        <UserManagementSection {...(currentUserEmail !== undefined ? { currentUserEmail } : {})} />
        <Separator />
        <GroupOverviewSection />
        <Separator />
        <StorageStatsSection />
        <Separator />
        <RegistrationControlSection />
        <Separator />
        <AnnouncementSection />
        <Separator />
        <ActivityFeedSection />
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
              <Database className="h-4 w-4" />
              {t('systemHealth.database')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <span
                className={`h-2.5 w-2.5 rounded-full ${data?.dbStatus === 'connected' ? 'bg-green-500' : 'bg-red-500'}`}
              />
              <span className="min-w-0 text-sm font-medium capitalize [overflow-wrap:anywhere]">
                {data?.dbStatus ?? 'unknown'}
              </span>
            </div>
          </CardContent>
        </Card>

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
              v{data?.version}
            </span>
            {data?.commitSha && data.commitSha !== 'unknown' && (
              <span
                className="block min-w-0 break-all font-mono text-xs text-muted-foreground"
                data-testid="admin-system-commit"
              >
                ({data.commitSha})
              </span>
            )}
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
  const [cleanupTarget, setCleanupTarget] = useState<'orphans' | 'unused' | null>(null);
  const storage = trpc.admin.getStorageStats.useQuery();
  const utils = trpc.useUtils();
  const cleanup = trpc.admin.cleanupOrphans.useMutation({
    onSuccess: () => {
      utils.admin.getStorageStats.invalidate();
      utils.admin.getAuditLog.invalidate();
      setCleanupTarget(null);
    },
  });
  const cleanupUnused = trpc.admin.cleanupUnusedReceipts.useMutation({
    onSuccess: () => {
      utils.admin.getStorageStats.invalidate();
      utils.admin.getAuditLog.invalidate();
      setCleanupTarget(null);
    },
  });

  const cleanupBusy = cleanup.isPending || cleanupUnused.isPending;

  if (storage.isLoading) return <SectionSkeleton title={t('storage.title')} />;

  const data = storage.data;

  return (
    <section className="min-w-0" data-testid="admin-storage-stats">
      <h2 className="mb-4 min-w-0 text-lg font-semibold [overflow-wrap:anywhere]">{t('storage.title')}</h2>
      <div className="grid min-w-0 gap-4 @2xl:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <FolderOpen className="h-4 w-4" />
              {t('storage.receipts')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="min-w-0 text-2xl font-bold [overflow-wrap:anywhere]">{data?.receiptCount ?? 0}</p>
            <p className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">{t('storage.inDatabase')}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <HardDrive className="h-4 w-4" />
              {t('storage.diskUsage')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="min-w-0 text-2xl font-bold [overflow-wrap:anywhere]" data-testid="admin-storage-disk-usage">
              {data?.totalDiskUsageFormatted ?? '0 B'}
            </p>
            <p className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {t('storage.filesOnDisk', { count: data?.diskFiles ?? 0 })}
            </p>
          </CardContent>
        </Card>

        <Card className="@2xl:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex min-w-0 flex-wrap items-center justify-between gap-2 [overflow-wrap:anywhere]">
              <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium text-muted-foreground [overflow-wrap:anywhere]">
                <FileWarning className="h-4 w-4" />
                {t('storage.orphanedFiles')}
              </span>
              {(data?.orphanCount ?? 0) > 0 && (
                <Button
                  size="sm"
                  variant="destructive"
                  className="min-h-11 min-w-11 whitespace-normal leading-tight"
                  data-testid="admin-storage-open-cleanup"
                  onClick={() => setCleanupTarget('orphans')}
                  disabled={cleanupBusy}
                >
                  {cleanup.isPending ? (
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
            <p className="min-w-0 text-2xl font-bold [overflow-wrap:anywhere]">{data?.orphanCount ?? 0}</p>
            <p className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {t('storage.orphanDescription')}
            </p>
            {cleanup.isSuccess && (
              <p className="mt-2 text-sm text-green-600">
                {t('storage.cleanedUp', { count: cleanup.data.deletedCount, size: cleanup.data.freedBytesFormatted })}
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="@2xl:col-span-2" data-testid="unused-receipts-card">
          <CardHeader className="pb-2">
            <CardTitle className="flex min-w-0 flex-wrap items-center justify-between gap-2 [overflow-wrap:anywhere]">
              <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium text-muted-foreground [overflow-wrap:anywhere]">
                <ReceiptText className="h-4 w-4" />
                {t('storage.unusedReceipts')}
              </span>
              {(data?.unusedReceiptCount ?? 0) > 0 && (
                <Button
                  size="sm"
                  variant="destructive"
                  className="min-h-11 min-w-11 whitespace-normal leading-tight"
                  data-testid="admin-storage-open-cleanup"
                  onClick={() => setCleanupTarget('unused')}
                  disabled={cleanupBusy}
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
            <p className="min-w-0 text-2xl font-bold [overflow-wrap:anywhere]">{data?.unusedReceiptCount ?? 0}</p>
            <p className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {t('storage.unusedDescription', { size: data?.unusedReceiptBytesFormatted ?? '0 B' })}
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
        open={cleanupTarget !== null}
        onOpenChange={(open) => {
          if (!open && !cleanupBusy) setCleanupTarget(null);
        }}
      >
        <DialogContent
          data-testid="admin-storage-cleanup-dialog"
          className="min-w-0 overflow-x-hidden [overflow-wrap:anywhere] [&_[data-slot=dialog-close]]:min-h-11 [&_[data-slot=dialog-close]]:min-w-11"
        >
          <DialogHeader className="min-w-0 pr-11">
            <DialogTitle className="[overflow-wrap:anywhere]">
              {cleanupTarget === 'orphans' ? t('storage.confirmOrphansTitle') : t('storage.confirmUnusedTitle')}
            </DialogTitle>
            <DialogDescription className="[overflow-wrap:anywhere]">
              {cleanupTarget === 'orphans'
                ? t('storage.confirmOrphansDescription', { count: data?.orphanCount ?? 0 })
                : t('storage.confirmUnusedDescription', { count: data?.unusedReceiptCount ?? 0 })}
            </DialogDescription>
          </DialogHeader>
          {cleanupTarget === 'orphans' && cleanup.isError && (
            <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
              {localizedTrpcError(cleanup.error, tc('errors.generic'))}
            </p>
          )}
          {cleanupTarget === 'unused' && cleanupUnused.isError && (
            <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
              {localizedTrpcError(cleanupUnused.error, tc('errors.generic'))}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11 min-w-11"
              data-testid="admin-storage-cleanup-cancel"
              disabled={cleanupBusy}
              onClick={() => setCleanupTarget(null)}
            >
              {t('storage.cancel')}
            </Button>
            <Button
              variant="destructive"
              className="min-h-11 min-w-11"
              data-testid="admin-storage-cleanup-confirm"
              disabled={
                cleanupBusy ||
                (cleanupTarget === 'orphans' ? (data?.orphanCount ?? 0) === 0 : (data?.unusedReceiptCount ?? 0) === 0)
              }
              onClick={() => {
                if (cleanupTarget === 'orphans' && (data?.orphanCount ?? 0) > 0) cleanup.mutate();
                if (cleanupTarget === 'unused' && (data?.unusedReceiptCount ?? 0) > 0) cleanupUnused.mutate();
              }}
            >
              {cleanupBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
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
