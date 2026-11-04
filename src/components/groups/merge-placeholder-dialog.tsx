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
 * Merge a placeholder into a member who has joined with an account: their
 * expenses, shares and payments move to that member and the placeholder goes.
 */
export function MergePlaceholderDialog({
  groupId,
  placeholder,
  members,
  open,
  onOpenChange,
}: {
  groupId: string;
  placeholder: { id: string; name: string };
  members: { id: string; name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('groups');
  const tc = useTranslations('common');
  const utils = trpc.useUtils();
  const [targetId, setTargetId] = useState('');
  const target = members.find((m) => m.id === targetId);

  const merge = trpc.groups.mergePlaceholder.useMutation({
    onSuccess: () => {
      toast.success(t('merge.done', { name: placeholder.name, member: target?.name ?? '' }));
      onOpenChange(false);
      void utils.groups.get.invalidate({ groupId });
      void utils.balances.invalidate();
      void utils.expenses.invalidate();
    },
    onError: (e) => toast.error(localizedTrpcError(e, tc('errors.generic'))),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain pb-[calc(1rem+env(safe-area-inset-bottom))] [overflow-wrap:anywhere] [&_[data-slot=dialog-close]]:size-11"
        data-testid="mobile-group-merge-dialog"
      >
        <DialogHeader className="min-w-0 pr-11">
          <DialogTitle className="min-w-0 [overflow-wrap:anywhere]">
            {t('merge.title', { name: placeholder.name })}
          </DialogTitle>
          <DialogDescription className="min-w-0 [overflow-wrap:anywhere]">
            {t('merge.description', { name: placeholder.name })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="merge-target">{t('merge.target')}</Label>
          <select
            id="merge-target"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="flex h-11 min-w-0 w-full scroll-mt-20 rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="" disabled>
              {t('merge.choose')}
            </option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {target && (
            <p className="text-sm text-muted-foreground">
              {t('merge.confirm', { name: placeholder.name, member: target.name })}
            </p>
          )}
        </div>
        <DialogFooter className="flex min-w-0 flex-wrap gap-2">
          <Button variant="outline" className="min-h-11 min-w-11 whitespace-normal" onClick={() => onOpenChange(false)}>
            {tc('actions.cancel')}
          </Button>
          <Button
            className="min-h-11 min-w-11 whitespace-normal"
            onClick={() => merge.mutate({ groupId, placeholderUserId: placeholder.id, realUserId: targetId })}
            disabled={!target || merge.isPending}
          >
            {merge.isPending ? t('merge.merging') : t('merge.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
