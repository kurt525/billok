'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { localizedTrpcError } from '@/lib/localized-trpc-error';

/**
 * Hand the group to another member who has an account. The owner becomes a
 * plain member, so they can leave the group afterwards (#309).
 */
export function TransferOwnershipDialog({
  groupId,
  members,
  open,
  onOpenChange,
}: {
  groupId: string;
  members: { id: string; name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('groups');
  const tc = useTranslations('common');
  const utils = trpc.useUtils();
  const [newOwnerId, setNewOwnerId] = useState('');
  const newOwner = members.find((m) => m.id === newOwnerId);

  const transfer = trpc.groups.transferOwnership.useMutation({
    onSuccess: () => {
      toast.success(t('transfer.done', { name: newOwner?.name ?? '' }));
      onOpenChange(false);
      void utils.groups.get.invalidate({ groupId });
      void utils.groups.list.invalidate();
    },
    onError: (e) => toast.error(localizedTrpcError(e, tc('errors.generic'))),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain pb-[calc(1rem+env(safe-area-inset-bottom))] [overflow-wrap:anywhere] [&_[data-slot=dialog-close]]:size-11"
        data-testid="mobile-group-transfer-dialog"
      >
        <DialogHeader className="min-w-0 pr-11">
          <DialogTitle className="min-w-0 [overflow-wrap:anywhere]">{t('transfer.title')}</DialogTitle>
          <DialogDescription className="min-w-0 [overflow-wrap:anywhere]">
            {t('transfer.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="transfer-target">{t('transfer.target')}</Label>
          <select
            id="transfer-target"
            value={newOwnerId}
            onChange={(e) => setNewOwnerId(e.target.value)}
            className="flex h-11 min-w-0 w-full scroll-mt-20 rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="" disabled>
              {t('transfer.choose')}
            </option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {newOwner && (
            <p className="text-sm text-muted-foreground">{t('transfer.confirm', { name: newOwner.name })}</p>
          )}
        </div>
        <DialogFooter className="flex min-w-0 flex-wrap gap-2">
          <Button variant="outline" className="min-h-11 min-w-11 whitespace-normal" onClick={() => onOpenChange(false)}>
            {tc('actions.cancel')}
          </Button>
          <Button
            variant="destructive"
            className="min-h-11 min-w-11 whitespace-normal"
            onClick={() => transfer.mutate({ groupId, newOwnerId })}
            disabled={!newOwner || transfer.isPending}
          >
            {transfer.isPending ? t('transfer.transferring') : t('transfer.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
