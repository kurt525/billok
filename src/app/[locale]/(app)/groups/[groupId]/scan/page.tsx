'use client';

import { Suspense, use, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ArrowLeft, Loader2, Users } from 'lucide-react';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import { ItemAssignment } from '@/components/receipts/item-assignment';
import { ArchivedGroupNotice } from '@/components/groups/archived-group-notice';
import { canStoreClaimIdentity, setStoredClaimIdentity } from '@/lib/guest-session';

/** Historical reader and manual receipt editor; no upload or OCR. */
export default function ScanReceiptPage({ params }: { params: Promise<{ groupId: string }> }) {
  return (
    <Suspense>
      <ReceiptContent params={params} />
    </Suspense>
  );
}

function ReceiptContent({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const receiptId = searchParams.get('receiptId');
  const t = useTranslations('expenses.scan');
  const tc = useTranslations('common');
  const { data: authSession } = useSession();

  useEffect(() => {
    if (!receiptId) router.replace('/groups/' + groupId + '/expenses/new');
  }, [receiptId, router, groupId]);

  const group = trpc.groups.get.useQuery({ groupId });
  const shareForClaiming = trpc.guest.createClaimSession.useMutation();
  const receiptData = trpc.receipts.getReceiptItems.useQuery({ receiptId: receiptId ?? '' }, { enabled: !!receiptId });
  const members =
    group.data?.members.map((m) => ({
      id: m.user.id,
      name: m.user.placeholderName ?? m.user.name ?? m.user.email,
    })) ?? [];

  async function handleShareForClaiming() {
    if (!receiptId || !receiptData.data) return;
    const { receipt, items } = receiptData.data;
    const extracted = receipt.extractedData;
    if (!extracted || !items.length) return;

    const currentMembers = members.filter((m) => m.name);
    if (!currentMembers.length) return;
    const myId = authSession?.user?.id;
    const myMember = myId ? currentMembers.find((m) => m.id === myId) : undefined;
    const myName = myMember?.name ?? authSession?.user?.name ?? currentMembers[0]?.name ?? tc('errors.notFound');
    const subtotal = receipt.isManual ? items.reduce((sum, item) => sum + item.totalPrice, 0) : extracted.subtotal;

    try {
      const result = await shareForClaiming.mutateAsync({
        receiptId,
        receiptData: {
          merchantName: extracted.merchantName,
          date: extracted.date,
          subtotal,
          tax: extracted.tax,
          tip: extracted.tip ?? 0,
          total: receipt.isManual
            ? subtotal + extracted.tax + (extracted.tip ?? 0)
            : (extracted.total ?? subtotal + extracted.tax + (extracted.tip ?? 0)),
          currency: extracted.currency ?? 'RUB',
        },
        items: items.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
        })),
        creatorName: myName,
        paidByName: myName,
        joinCreator: canStoreClaimIdentity(),
      });
      if (result.creator) {
        setStoredClaimIdentity(result.shareToken, {
          name: result.creator.name,
          personToken: result.creator.personToken,
        });
      }
      router.push('/split/' + result.shareToken + '/claim');
    } catch {
      toast.error(t('createSessionFailed'));
    }
  }

  if (!receiptId) return <div role="status">Открываем ручной ввод расхода…</div>;
  if (group.isLoading) {
    return (
      <div className="mx-auto max-w-lg flex flex-col items-center gap-4 py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-muted-foreground">{t('loadingGroup')}</p>
      </div>
    );
  }
  if (group.error) {
    return (
      <Card className="mx-auto max-w-lg border-destructive/50">
        <CardContent className="py-6">
          <p role="alert" className="text-destructive">
            {t('groupLoadError')}
          </p>
        </CardContent>
      </Card>
    );
  }
  if (group.data?.archivedAt) return <ArchivedGroupNotice groupId={groupId} />;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={tc('actions.back')}
          nativeButton={false}
          render={<Link href={'/groups/' + groupId} />}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">
          {receiptData.data?.receipt.isManual ? t('manualTitle') : t('savedReceiptTitle')}
        </h1>
      </div>
      <ItemAssignment
        key={receiptId}
        groupId={groupId}
        receiptId={receiptId}
        members={members}
        onComplete={() => router.push('/groups/' + groupId)}
        onSaveForLater={() => router.push('/groups/' + groupId)}
      />
      <Button
        type="button"
        variant="outline"
        className="min-h-11 w-full"
        onClick={handleShareForClaiming}
        disabled={
          shareForClaiming.isPending ||
          !authSession?.user?.id ||
          !receiptData.data?.receipt.extractedData ||
          !receiptData.data.items.length ||
          !members.length
        }
        data-testid="group-share-claiming-btn"
      >
        <Users className="mr-2 h-4 w-4" />
        {shareForClaiming.isPending ? t('creatingSession') : t('shareForClaiming')}
      </Button>
    </div>
  );
}
