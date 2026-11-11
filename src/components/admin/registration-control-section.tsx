'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Loader2, ShieldCheck, Plus, Copy, Ban, Check } from 'lucide-react';

export function RegistrationControlSection() {
  const t = useTranslations('admin');
  const locale = useLocale();
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
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; codePreview: string } | null>(null);

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
                  disabled={setMode.isPending || currentMode === mode}
                  onClick={() => setMode.mutate({ mode })}
                >
                  {setMode.isPending && setMode.variables?.mode === mode ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : null}
                  {MODE_INFO[mode].label}
                </Button>
              ))}
            </div>
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
                disabled={createInvite.isPending}
                onClick={() => {
                  createInvite.mutate({
                    label: inviteLabel || undefined,
                    expiresInDays: 7,
                  });
                  setInviteLabel('');
                }}
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
          </CardContent>
        </Card>
      </div>

      {invites.data && invites.data.length > 0 && (
        <Card className="mt-4 min-w-0">
          <CardContent className="p-0">
            <div data-testid="admin-invites-scroll" className="min-w-0 max-w-full overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">{t('registration.colCode')}</th>
                    <th className="px-4 py-3 font-medium">{t('registration.colLabel')}</th>
                    <th className="px-4 py-3 font-medium">{t('registration.colStatus')}</th>
                    <th className="px-4 py-3 font-medium">{t('registration.colCreated')}</th>
                    <th className="px-4 py-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {invites.data.map((inv) => (
                    <tr key={inv.id} data-testid="admin-invitation-row" className="border-b last:border-0">
                      <td className="px-4 py-3 font-mono text-xs">
                        <div className="flex min-w-0 items-center gap-1">
                          {inv.code.slice(0, 12)}...
                          <button
                            type="button"
                            className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted"
                            aria-label={t('registration.copyCode')}
                            title={t('registration.copyCode')}
                            onClick={() => {
                              navigator.clipboard.writeText(inv.code);
                              setCopiedCode(inv.code);
                              setTimeout(() => setCopiedCode(null), 2000);
                            }}
                          >
                            {copiedCode === inv.code ? (
                              <Check className="h-3 w-3 text-green-600" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </button>
                        </div>
                      </td>
                      <td className="max-w-48 px-4 py-3 text-muted-foreground [overflow-wrap:anywhere]">
                        {inv.label ?? '---'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex min-w-0 flex-col items-start gap-1">
                          {inv.revokedAt ? (
                            <Badge variant="destructive">{t('registration.statusRevoked')}</Badge>
                          ) : inv.usedAt ? (
                            <Badge variant="secondary" className="max-w-48 whitespace-normal [overflow-wrap:anywhere]">
                              {inv.usedBy
                                ? t('registration.statusUsedBy', { name: inv.usedBy.name ?? inv.usedBy.email ?? '' })
                                : t('registration.statusUsed')}
                            </Badge>
                          ) : inv.isReserved ? (
                            <Badge variant="outline">{t('registration.statusReserved')}</Badge>
                          ) : inv.isActive ? (
                            <Badge variant="default">{t('registration.statusActive')}</Badge>
                          ) : (
                            <Badge variant="outline">{t('registration.statusExpired')}</Badge>
                          )}
                          {inv.usedAt ? (
                            <span className="text-xs text-muted-foreground" data-testid="admin-invitation-used-at">
                              {t('registration.usedAt', { date: new Date(inv.usedAt).toLocaleString(locale) })}
                            </span>
                          ) : inv.revokedAt ? (
                            <span className="text-xs text-muted-foreground">
                              {t('registration.revokedAt', { date: new Date(inv.revokedAt).toLocaleString(locale) })}
                            </span>
                          ) : inv.expiresAt ? (
                            <span className="text-xs text-muted-foreground">
                              {t('registration.expiresAt', { date: new Date(inv.expiresAt).toLocaleString(locale) })}
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {new Date(inv.createdAt).toLocaleDateString(locale)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {inv.canRevoke && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="size-11 shrink-0"
                            data-testid="admin-registration-revoke-invite"
                            onClick={() => setRevokeTarget({ id: inv.id, codePreview: inv.code.slice(0, 12) + '…' })}
                            disabled={revokeInvite.isPending}
                            aria-label={t('registration.revoke')}
                            title={t('registration.revoke')}
                          >
                            <Ban className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title={t('registration.revokeTitle')}
        description={t('registration.revokeDescription', { code: revokeTarget?.codePreview ?? '' })}
        confirmLabel={t('registration.revoke')}
        onConfirm={() => {
          if (revokeTarget)
            revokeInvite.mutate({ inviteId: revokeTarget.id }, { onSettled: () => setRevokeTarget(null) });
        }}
      />
    </section>
  );
}
