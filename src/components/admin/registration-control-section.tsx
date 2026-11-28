'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { approveOwnerPrivilegedAction } from '@/lib/owner-admin-approval';
import { systemInviteCreateApprovalTarget } from '@/lib/system-invite-approval-target';
import { registrationModeApprovalTarget, type RegistrationSettingMode } from '@/lib/admin-setting-approval-target';
import { useLocale, useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Loader2, ShieldCheck, Plus, Copy, Ban, Check, Ticket } from 'lucide-react';
import { createAuditDateFormatter } from './audit-log-format';
import { invitationDisplay } from './invitation-display';

export function RegistrationControlSection() {
  const t = useTranslations('admin');
  const locale = useLocale();
  const dates = createAuditDateFormatter(locale);
  const utils = trpc.useUtils();
  const regMode = trpc.admin.getRegistrationMode.useQuery();
  const setMode = trpc.admin.setRegistrationMode.useMutation({
    onSuccess: () => utils.admin.getRegistrationMode.invalidate(),
  });
  const invites = trpc.admin.listSystemInvites.useQuery();
  const createInvite = trpc.admin.createSystemInvite.useMutation({
    onSuccess: () => {
      utils.admin.listSystemInvites.invalidate();
      utils.admin.getAuditLog.invalidate();
    },
  });
  const revokeInvite = trpc.admin.revokeSystemInvite.useMutation({
    onSuccess: () => {
      utils.admin.listSystemInvites.invalidate();
      utils.admin.getAuditLog.invalidate();
    },
  });

  const [inviteLabel, setInviteLabel] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; codePreview: string } | null>(null);
  const [approvingInvite, setApprovingInvite] = useState(false);
  const [approvingMode, setApprovingMode] = useState(false);

  const currentMode = regMode.data?.mode ?? 'open';

  const MODE_INFO = {
    open: {
      label: t('registration.open'),
      description: t('registration.openDescription'),
      variant: 'default' as const,
    },
    'invite-only': {
      label: t('registration.inviteOnly'),
      description: t('registration.inviteOnlyDescription'),
      variant: 'secondary' as const,
    },
    closed: {
      label: t('registration.closed'),
      description: t('registration.closedDescription'),
      variant: 'destructive' as const,
    },
  };

  async function setModeWithPasskey(mode: RegistrationSettingMode) {
    if (approvingMode || setMode.isPending || currentMode === mode) return;
    setApprovingMode(true);
    try {
      const approvalToken = await approveOwnerPrivilegedAction(
        'REGISTRATION_MODE_UPDATE',
        registrationModeApprovalTarget(mode),
      );
      await setMode.mutateAsync({ mode, approvalToken });
    } catch {
      toast.error('Изменение режима регистрации не подтверждено через Passkey');
    } finally {
      setApprovingMode(false);
    }
  }

  async function createWithPasskey() {
    if (approvingInvite || createInvite.isPending || revokeInvite.isPending) return;
    setApprovingInvite(true);
    try {
      const label = inviteLabel.trim() || undefined;
      const targetId = systemInviteCreateApprovalTarget(label);
      const approvalToken = await approveOwnerPrivilegedAction('SYSTEM_INVITE_CREATE', targetId);
      await createInvite.mutateAsync({ label, expiresInDays: 7, approvalToken });
      setInviteLabel('');
    } catch {
      toast.error('Создание приглашения не подтверждено через Passkey');
    } finally {
      setApprovingInvite(false);
    }
  }

  async function revokeWithPasskey(selectedInviteId: string) {
    if (!selectedInviteId || approvingInvite || createInvite.isPending || revokeInvite.isPending) return;
    setApprovingInvite(true);
    try {
      const approvalToken = await approveOwnerPrivilegedAction('SYSTEM_INVITE_REVOKE', selectedInviteId);
      await revokeInvite.mutateAsync({ inviteId: selectedInviteId, approvalToken });
      setRevokeTarget(null);
    } catch {
      toast.error('Отзыв приглашения не подтверждён через Passkey');
    } finally {
      setApprovingInvite(false);
    }
  }

  return (
    <section data-testid="admin-registration-control" className="min-w-0">
      <div className="mb-4 flex min-w-0 items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-muted-foreground" />
        <h2 className="min-w-0 text-lg font-semibold [overflow-wrap:anywhere]">{t('registration.title')}</h2>
      </div>

      <div className="grid min-w-0 gap-4 @2xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('registration.modeTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Badge variant={MODE_INFO[currentMode].variant} className="max-w-full whitespace-normal">
                {MODE_INFO[currentMode].label}
              </Badge>
              <span className="min-w-0 flex-1 basis-32 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {MODE_INFO[currentMode].description}
              </span>
            </div>
            <div className="flex min-w-0 flex-wrap gap-2">
              {(Object.keys(MODE_INFO) as Array<keyof typeof MODE_INFO>).map((mode) => (
                <Button
                  key={mode}
                  data-testid={'admin-registration-mode-' + mode}
                  variant={currentMode === mode ? 'default' : 'outline'}
                  size="sm"
                  className="min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere]"
                  disabled={approvingMode || setMode.isPending || currentMode === mode}
                  onClick={() => void setModeWithPasskey(mode)}
                >
                  {setMode.isPending && setMode.variables?.mode === mode ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : null}
                  {MODE_INFO[mode].label}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Смена режима регистрации подтверждается Passkey владельца.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('registration.createInvite')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex min-w-0 flex-wrap gap-2">
              <Input
                data-testid="admin-registration-invite-label"
                aria-label={t('registration.labelPlaceholder')}
                placeholder={t('registration.labelPlaceholder')}
                value={inviteLabel}
                onChange={(e) => setInviteLabel(e.target.value)}
                className="min-h-11 min-w-0 flex-1 basis-40 scroll-mt-20 text-base"
              />
              <Button
                data-testid="admin-registration-create-invite"
                size="sm"
                className="min-h-11 min-w-11 whitespace-normal"
                disabled={createInvite.isPending || approvingInvite || revokeInvite.isPending}
                onClick={() => void createWithPasskey()}
              >
                {createInvite.isPending ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="mr-1 h-3 w-3" />
                )}
                {t('registration.create')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('registration.inviteExpiry')}</p>
            <p className="break-words text-xs text-muted-foreground">
              Создание приглашения требует подтверждения Passkey владельца.
            </p>
          </CardContent>
        </Card>
      </div>

      {invites.data && invites.data.length > 0 && (
        <ul
          className="mt-4 min-w-0 space-y-3"
          data-testid="admin-invites-list"
          aria-label={t('registration.invitesTitle')}
        >
          {invites.data.map((inv) => {
            const info = invitationDisplay(inv);
            const usedName = inv.usedBy?.name?.trim() || inv.usedBy?.email || '';
            const status =
              info.status === 'revoked'
                ? t('registration.statusRevoked')
                : info.status === 'used'
                  ? t('registration.statusUsed')
                  : info.status === 'reserved'
                    ? t('registration.statusReserved')
                    : info.status === 'active'
                      ? t('registration.statusActive')
                      : t('registration.statusExpired');
            const expiryLabel =
              info.status === 'used' || info.status === 'revoked'
                ? t('registration.originalExpiry')
                : info.status === 'expired'
                  ? t('registration.expiredAtLabel')
                  : t('registration.validUntil');
            return (
              <li key={inv.id} className="min-w-0" data-testid="admin-invitation-row">
                <Card className="min-w-0">
                  <CardContent className="min-w-0 space-y-3 px-3 py-3">
                    <div className="flex min-w-0 items-start gap-2">
                      <Ticket className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="font-medium [overflow-wrap:anywhere]">
                          {inv.label?.trim() || t('registration.inviteUntitled')}
                        </p>
                        <p
                          data-testid="admin-invitation-status"
                          className={
                            'text-sm font-semibold [overflow-wrap:anywhere] ' +
                            (info.status === 'revoked' ? 'text-destructive' : 'text-foreground')
                          }
                        >
                          {status}
                        </p>
                        {inv.usedAt && usedName && (
                          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                            {t('registration.usedUser', { name: usedName })}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="min-w-0 flex-1 text-xs [overflow-wrap:anywhere]">
                        {t('registration.colCode')}: <span className="font-mono">{inv.code.slice(0, 12)}…</span>
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="size-11 shrink-0"
                        aria-label={t('registration.copyCode')}
                        title={t('registration.copyCode')}
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(inv.code);
                            setCopiedId(inv.id);
                            setTimeout(() => setCopiedId((id) => (id === inv.id ? null : id)), 2000);
                            toast.success(t('registration.copySuccess'));
                          } catch {
                            toast.error(t('registration.copyFailed'));
                          }
                        }}
                      >
                        {copiedId === inv.id ? <Check className="size-4" /> : <Copy className="size-4" />}
                      </Button>
                    </div>
                    <dl className="min-w-0 space-y-2 border-t pt-2 text-sm [overflow-wrap:anywhere]">
                      <div>
                        <dt className="text-xs text-muted-foreground">{t('registration.createdLabel')}</dt>
                        <dd data-testid="admin-invitation-created-at">
                          {info.created ? (
                            <time dateTime={info.created.toISOString()}>{dates.full(info.created)}</time>
                          ) : (
                            t('registration.dateUnknown')
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">{expiryLabel}</dt>
                        <dd data-testid="admin-invitation-expires-at">
                          {info.expiry ? (
                            <time dateTime={info.expiry.toISOString()}>{dates.full(info.expiry)}</time>
                          ) : (
                            t('registration.dateUnknown')
                          )}
                        </dd>
                      </div>
                      {inv.usedAt && (
                        <div data-testid="admin-invitation-used-at">
                          <dt className="text-xs text-muted-foreground">{t('registration.usedLabel')}</dt>
                          <dd>
                            {info.used ? (
                              <time dateTime={info.used.toISOString()}>{dates.full(info.used)}</time>
                            ) : (
                              t('registration.dateUnknown')
                            )}
                          </dd>
                        </div>
                      )}
                      {inv.revokedAt && (
                        <div data-testid="admin-invitation-revoked-at">
                          <dt className="text-xs text-muted-foreground">{t('registration.revokedLabel')}</dt>
                          <dd>
                            {info.revoked ? (
                              <time dateTime={info.revoked.toISOString()}>{dates.full(info.revoked)}</time>
                            ) : (
                              t('registration.dateUnknown')
                            )}
                          </dd>
                        </div>
                      )}
                    </dl>
                    {inv.canRevoke && (info.status === 'active' || info.status === 'reserved') && (
                      <div className="border-t pt-2">
                        <Button
                          variant="ghost"
                          className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-destructive [overflow-wrap:anywhere]"
                          data-testid="admin-registration-revoke-invite"
                          onClick={() => setRevokeTarget({ id: inv.id, codePreview: inv.code.slice(0, 12) + '…' })}
                          disabled={revokeInvite.isPending || approvingInvite || createInvite.isPending}
                          aria-label={t('registration.revoke')}
                        >
                          <Ban className="size-4 shrink-0" />
                          {t('registration.revoke')}
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && !approvingInvite && setRevokeTarget(null)}
        title={t('registration.revokeTitle')}
        description={t('registration.revokeDescription', { code: revokeTarget?.codePreview ?? '' })}
        confirmLabel={t('registration.revoke')}
        onConfirm={() => revokeTarget && void revokeWithPasskey(revokeTarget.id)}
      />
    </section>
  );
}
