'use client';

import { useState, useId } from 'react';
import { useTranslations } from 'next-intl';
import { Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { localizedTrpcError } from '@/lib/localized-trpc-error';
import { MAX_RECEIPT_TITLE_LENGTH, normalizeReceiptTitle } from '@/lib/receipt-title';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function ReceiptTitleEditor({ id, title }: { id: string; title: string }) {
  const t = useTranslations('splits');
  const tc = useTranslations('common');
  const inputId = useId();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const rename = trpc.guest.renameReceipt.useMutation({
    onSuccess: async () => {
      setOpen(false);
      setError('');
      toast.success(t('renamed'));
      await Promise.all([
        utils.guest.mySplits.invalidate(),
        utils.guest.getSession.invalidate(),
        utils.guest.getSplit.invalidate(),
      ]);
    },
    onError: (err) => setError(localizedTrpcError(err, tc('errors.generic'))),
  });
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="relative z-10 size-11 shrink-0"
        aria-label={t('rename')}
        data-testid="receipt-rename-open"
        onClick={() => {
          setDraft(title);
          setError('');
          setOpen(true);
        }}
      >
        <Pencil className="size-4" aria-hidden="true" />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!rename.isPending) setOpen(next);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="min-w-0 [overflow-wrap:anywhere]"
          data-testid="receipt-rename-dialog"
        >
          <DialogHeader>
            <DialogTitle>{t('rename')}</DialogTitle>
          </DialogHeader>
          <form
            className="min-w-0 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (rename.isPending) return;
              const normalized = normalizeReceiptTitle(draft);
              if (!normalized) {
                setError(t('renameInvalid', { max: MAX_RECEIPT_TITLE_LENGTH }));
                return;
              }
              rename.mutate({ id, title: normalized });
            }}
          >
            <label htmlFor={inputId} className="block text-sm font-medium">
              {t('renameLabel')}
            </label>
            <Input
              id={inputId}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setError('');
              }}
              className="min-h-11 min-w-0 text-base"
              disabled={rename.isPending}
              aria-invalid={!!error}
              data-testid="receipt-rename-input"
            />
            {error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex min-w-0 flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 flex-1 whitespace-normal"
                disabled={rename.isPending}
                onClick={() => setOpen(false)}
              >
                {tc('actions.cancel')}
              </Button>
              <Button
                type="submit"
                className="min-h-11 flex-1 whitespace-normal"
                disabled={rename.isPending}
                data-testid="receipt-rename-save"
              >
                {tc('actions.save')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ReceiptTitleHeading({ id, title, canRename }: { id: string; title: string; canRename: boolean }) {
  return (
    <div className="flex min-w-0 items-center justify-center gap-1">
      <h1 className="min-w-0 text-2xl font-bold [overflow-wrap:anywhere]" data-testid="receipt-title">
        {title}
      </h1>
      {canRename && <ReceiptTitleEditor id={id} title={title} />}
    </div>
  );
}
