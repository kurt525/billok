'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Check, Copy, Link } from 'lucide-react';
import { toast } from 'sonner';
import { localizedTrpcError } from '@/lib/localized-trpc-error';
import { copyToClipboard } from '@/lib/clipboard';

/**
 * Invite link for the group. Given a placeholder, the link is theirs to claim:
 * whoever accepts it takes over the placeholder's expenses and payments.
 */
export function InviteDialog({
  groupId,
  placeholder,
  open,
  onOpenChange,
}: {
  groupId: string;
  placeholder?: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const t = useTranslations('groups');
  const tc = useTranslations('common');

  const createInvite = trpc.groups.createInvite.useMutation({
    onError: (e) => toast.error(localizedTrpcError(e, tc('errors.generic'))),
  });

  function handleGenerate() {
    createInvite.mutate(placeholder ? { groupId, placeholderUserId: placeholder.id } : { groupId });
  }

  function getInviteUrl(token: string) {
    const base = typeof window !== 'undefined' ? window.location.origin : '';
    return `${base}/invite/${token}`;
  }

  async function handleCopy() {
    if (!createInvite.data) return;
    const url = getInviteUrl(createInvite.data.token);
    if (!(await copyToClipboard(url))) {
      toast.error(tc('actions.copyFailed'));
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto overscroll-contain pb-[calc(1rem+env(safe-area-inset-bottom))]"
        data-testid="mobile-invite-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {placeholder ? t('invite.claimTitle', { name: placeholder.name }) : t('invite.title')}
          </DialogTitle>
          <DialogDescription>
            {placeholder ? t('invite.claimDescription', { name: placeholder.name }) : t('invite.description')}
          </DialogDescription>
        </DialogHeader>

        {!createInvite.data ? (
          <Button
            className="min-h-12 w-full whitespace-normal"
            onClick={handleGenerate}
            disabled={createInvite.isPending}
          >
            <Link className="mr-2 h-4 w-4" />
            {createInvite.isPending ? t('invite.generating') : t('invite.generateLink')}
          </Button>
        ) : (
          <div className="space-y-3">
            <div className="flex min-w-0 gap-2">
              <Input
                readOnly
                aria-label={t('invite.copyLink')}
                value={getInviteUrl(createInvite.data.token)}
                className="h-11 min-w-0 flex-1 font-mono text-xs"
              />
              <Button
                variant="outline"
                size="icon"
                className="size-12 shrink-0"
                aria-label={t('invite.copyLink')}
                data-testid="mobile-copy-invite"
                onClick={handleCopy}
              >
                {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {placeholder ? t('invite.claimLinkInfo', { name: placeholder.name }) : t('invite.linkInfo')}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
