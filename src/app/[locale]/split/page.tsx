'use client';

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter, Link } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { centsToDecimal, formatCents, parseToCents } from '@/lib/money';
import { parseReceiptQuantity } from '@/lib/receipt-quantity';
import { setStoredClaimIdentity } from '@/lib/guest-session';
import { localizedTrpcError } from '@/lib/localized-trpc-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { ArrowLeft, ArrowRight, Pencil, Plus, Scissors, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';

type GuestItem = { name: string; quantity: number; unitPrice: number; totalPrice: number };
type ItemDraft = { name: string; quantity: string; totalPrice: string };
const emptyItem = (): ItemDraft => ({ name: '', quantity: '1', totalPrice: '' });

export default function GuestSplitPage() {
  const { status } = useSession();
  const t = useTranslations('split');
  if (status === 'loading') return <LoadingSpinner />;
  if (status !== 'authenticated') {
    return (
      <div className="space-y-4 text-center" data-testid="manual-split-sign-in-required">
        <h1 className="text-2xl font-bold">{t('upload.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('manual.signInRequired')}</p>
        <Link
          href="/login?callbackUrl=%2Fsplit"
          className="inline-flex min-h-12 items-center justify-center rounded-md bg-primary px-6 text-base font-medium text-primary-foreground"
        >
          {t('manual.signInButton')}
        </Link>
      </div>
    );
  }
  return <ReceiptCreationForm />;
}

function ReceiptCreationForm() {
  const { data: currentUser } = useSession();
  const t = useTranslations('split');
  const tc = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();

  // One creation flow. Guest places can be expanded in the created receipt.
  const [step, setStep] = useState<'people' | 'assign'>('people');
  const [receiptName, setReceiptName] = useState('');
  const [guestCount, setGuestCount] = useState(2);
  const [payerGuestSlot, setPayerGuestSlot] = useState(0);
  const [items, setItems] = useState<GuestItem[]>([]);
  const [addingItem, setAddingItem] = useState(false);
  const [newItem, setNewItem] = useState<ItemDraft>(emptyItem);
  const [editingItem, setEditingItem] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<ItemDraft>(emptyItem);
  const [splittingItem, setSplittingItem] = useState<number | null>(null);
  const [splitQuantity, setSplitQuantity] = useState('1');
  const createClaimSession = trpc.guest.createClaimSession.useMutation();

  const subtotal = items.reduce((sum, item) => sum + item.totalPrice, 0);
  const currency = 'RUB';

  function readDraft(draft: ItemDraft): GuestItem | null {
    const name = draft.name.trim();
    const quantity = parseReceiptQuantity(draft.quantity);
    const totalPrice = parseToCents(draft.totalPrice);
    if (!name) {
      toast.error(t('assign.validationNameRequired'));
      return null;
    }
    if (quantity === null) {
      toast.error(t('assign.validationQtyPositive'));
      return null;
    }
    if (totalPrice <= 0) {
      toast.error(t('assign.validationPricePositive'));
      return null;
    }
    return { name, quantity, totalPrice, unitPrice: Math.round(totalPrice / quantity) };
  }

  function handleAddItem(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const item = readDraft(newItem);
    if (!item) return;
    setItems((current) => [...current, item]);
    setNewItem(emptyItem());
    setAddingItem(false);
  }

  function startEditing(index: number) {
    const item = items[index];
    if (!item) return;
    setSplittingItem(null);
    setEditingItem(index);
    setEditValues({
      name: item.name,
      quantity: String(item.quantity),
      totalPrice: centsToDecimal(item.totalPrice),
    });
  }

  function saveEdit() {
    if (editingItem === null) return;
    const item = readDraft(editValues);
    if (!item) return;
    setItems((previous) => previous.map((old, index) => (index === editingItem ? item : old)));
    setEditingItem(null);
  }

  function deleteItem(index: number) {
    setItems((current) => current.filter((_, idx) => idx !== index));
    setEditingItem(null);
    setSplittingItem(null);
  }

  function handleSplitItem(index: number) {
    const item = items[index];
    const count = Number(splitQuantity);
    if (!item || !Number.isSafeInteger(count) || count < 1 || count >= item.quantity) return;
    const extractedPrice = Math.round((item.totalPrice * count) / item.quantity);
    const remainingPrice = item.totalPrice - extractedPrice;
    if (extractedPrice <= 0 || remainingPrice <= 0) return;
    setItems((previous) => {
      const updated = [...previous];
      updated.splice(
        index,
        1,
        {
          ...item,
          quantity: item.quantity - count,
          totalPrice: remainingPrice,
          unitPrice: Math.round(remainingPrice / (item.quantity - count)),
        },
        { ...item, quantity: count, totalPrice: extractedPrice, unitPrice: Math.round(extractedPrice / count) },
      );
      return updated;
    });
    setSplittingItem(null);
  }

  async function handleCreateReceipt() {
    if (items.length === 0 || createClaimSession.isPending) return;
    try {
      const result = await createClaimSession.mutateAsync({
        receiptData: {
          merchantName: receiptName.trim() || t('manual.defaultTitle'),
          subtotal,
          tax: 0,
          tip: 0,
          total: subtotal,
          currency,
        },
        items,
        guestCount,
        ...(payerGuestSlot > 0 ? { paidByGuestSlot: payerGuestSlot } : {}),
        joinCreator: true,
      });
      if (result.creator) {
        setStoredClaimIdentity(result.shareToken, {
          name: result.creator.name,
          personToken: result.creator.personToken,
        });
      }
      router.push('/split/' + result.shareToken + '/claim');
    } catch (error) {
      toast.error(localizedTrpcError(error as { message: string; data?: { code?: string } }, tc('errors.generic')));
    }
  }

  return (
    <div className={step === 'assign' ? 'min-w-0 space-y-4 pb-36' : 'min-w-0 space-y-6 pb-28'}>
      {step === 'people' ? (
        <section className="space-y-5">
          <h1 className="text-2xl font-bold" data-testid="manual-split-title">
            {t('upload.title')}
          </h1>
          <h2 className="text-xl font-semibold" data-testid="guest-people-step">
            {t('people.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('manual.subtitle')}</p>
          <div className="space-y-2">
            <Label htmlFor="manual-receipt-name">{t('manual.receiptName')}</Label>
            <Input
              id="manual-receipt-name"
              value={receiptName}
              onChange={(event) => setReceiptName(event.target.value)}
              placeholder={t('manual.defaultTitle')}
              className="h-12 min-w-0 text-base"
              data-testid="manual-receipt-name"
            />
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">{t('people.creatorAlwaysIncluded')}</p>
            <p className="min-w-0 font-semibold [overflow-wrap:anywhere]" data-testid="invite-creator-name">
              {currentUser?.user?.name || t('people.creatorProfileName')}
            </p>
          </div>
          <div className="space-y-2" data-testid="guest-count-form">
            <Label htmlFor="guest-count">{t('people.guestCountLabel')}</Label>
            <Input
              id="guest-count"
              type="number"
              inputMode="numeric"
              min={0}
              max={99}
              step={1}
              value={guestCount}
              onChange={(event) => {
                const numeric = Number(event.target.value);
                if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 99) return;
                setGuestCount(numeric);
                setPayerGuestSlot((previous) => Math.min(previous, numeric));
              }}
              className="h-12 w-full text-base"
              data-testid="guest-count-input"
            />
            <p className="text-xs text-muted-foreground">{t('people.guestCountHint')}</p>
            <div className="max-h-44 space-y-2 overflow-y-auto rounded-lg border p-2" data-testid="guest-slot-preview">
              {Array.from({ length: guestCount }, (_, index) => (
                <div key={index} className="rounded-md bg-muted px-3 py-2 text-sm">
                  {t('people.guestPlace', { index: index + 1 })}
                </div>
              ))}
              {guestCount === 0 && <p className="px-2 py-3 text-sm">{t('people.noAdditionalGuests')}</p>}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-payer">{t('people.whoPaid')}</Label>
            <select
              id="invite-payer"
              value={payerGuestSlot}
              onChange={(event) => setPayerGuestSlot(Number(event.target.value))}
              className="flex h-12 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-base"
              data-testid="invite-payer"
            >
              <option value={0}>{t('people.creatorPayer')}</option>
              {Array.from({ length: guestCount }, (_, index) => (
                <option key={index} value={index + 1}>
                  {t('people.guestPlace', { index: index + 1 })}
                </option>
              ))}
            </select>
          </div>
          <div className="fixed right-0 bottom-0 left-0 z-10 max-h-[calc(100dvh-1rem)] overflow-y-auto overscroll-contain border-t bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <div className="mx-auto max-w-lg">
              <Button className="h-14 w-full text-lg" onClick={() => setStep('assign')} data-testid="next-assign-btn">
                {t('people.nextAssign')} <ArrowRight className="ml-2 size-5" />
              </Button>
            </div>
          </div>
        </section>
      ) : (
        <section className="min-w-0 space-y-4" data-testid="guest-assign-step">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" aria-label={tc('actions.back')} onClick={() => setStep('people')}>
              <ArrowLeft className="size-4" />
            </Button>
            <h2 className="text-xl font-bold">{t('assign.title')}</h2>
          </div>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{receiptName.trim() || t('manual.defaultTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap justify-between gap-2 text-sm">
              <span>{t('assign.total')}</span>
              <span className="font-semibold">{formatCents(subtotal, currency, locale)}</span>
            </CardContent>
          </Card>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full"
            onClick={() => {
              setEditingItem(null);
              setSplittingItem(null);
              setAddingItem(true);
            }}
            data-testid="guest-add-item-btn"
          >
            <Plus className="mr-2 size-4" /> {t('assign.addItem')}
          </Button>
          {items.length === 0 && !addingItem && (
            <p
              className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground"
              data-testid="manual-no-items"
            >
              {t('manual.addFirstItem')}
            </p>
          )}
          {addingItem && (
            <Card className="border-primary/50">
              <CardContent className="py-3">
                <form onSubmit={handleAddItem} className="min-w-0 space-y-2" data-testid="manual-item-entry-form">
                  <Input
                    value={newItem.name}
                    onChange={(event) => setNewItem((old) => ({ ...old, name: event.target.value }))}
                    placeholder={t('assign.itemNamePlaceholder')}
                    required
                    className="h-12 min-w-0 text-base"
                  />
                  <div className="grid min-w-0 grid-cols-2 gap-2">
                    <Input
                      type="number"
                      inputMode="numeric"
                      min="1"
                      value={newItem.quantity}
                      onChange={(event) => setNewItem((old) => ({ ...old, quantity: event.target.value }))}
                      placeholder={t('assign.qtyPlaceholder')}
                      className="h-12 min-w-0 text-base"
                    />
                    <Input
                      type="text"
                      inputMode="decimal"
                      value={newItem.totalPrice}
                      onChange={(event) => setNewItem((old) => ({ ...old, totalPrice: event.target.value }))}
                      placeholder={t('assign.pricePlaceholder')}
                      required
                      className="h-12 min-w-0 text-base"
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" className="min-h-11" data-testid="guest-add-item-submit">
                      {t('assign.add')}
                    </Button>
                    <Button type="button" variant="ghost" className="min-h-11" onClick={() => setAddingItem(false)}>
                      {t('assign.cancel')}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}
          <div className="min-w-0 space-y-2" data-testid="receipt-items-list">
            {items.map((item, index) => (
              <Card key={index} data-testid={'guest-item-card-' + index}>
                <CardContent className="min-w-0 space-y-2 py-3">
                  {editingItem === index ? (
                    <div className="min-w-0 space-y-2" data-testid="guest-edit-item-form">
                      <Input
                        value={editValues.name}
                        onChange={(event) => setEditValues((old) => ({ ...old, name: event.target.value }))}
                        placeholder={t('assign.itemNamePlaceholder')}
                        className="h-12 min-w-0 text-base"
                      />
                      <div className="grid min-w-0 grid-cols-2 gap-2">
                        <Input
                          type="number"
                          inputMode="numeric"
                          min="1"
                          value={editValues.quantity}
                          onChange={(event) => setEditValues((old) => ({ ...old, quantity: event.target.value }))}
                          placeholder={t('assign.qtyPlaceholder')}
                          className="h-12 min-w-0 text-base"
                        />
                        <Input
                          type="text"
                          inputMode="decimal"
                          value={editValues.totalPrice}
                          onChange={(event) => setEditValues((old) => ({ ...old, totalPrice: event.target.value }))}
                          placeholder={t('assign.pricePlaceholder')}
                          className="h-12 min-w-0 text-base"
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button className="min-h-11" onClick={saveEdit}>
                          {t('assign.save')}
                        </Button>
                        <Button variant="ghost" className="min-h-11" onClick={() => setEditingItem(null)}>
                          {t('assign.cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                        <span
                          className="min-w-0 [overflow-wrap:anywhere] font-medium"
                          data-testid={'receipt-item-name-' + index}
                        >
                          {item.name}
                        </span>
                        {item.quantity > 1 && <span className="text-xs text-muted-foreground">×{item.quantity}</span>}
                      </div>
                      <span className="shrink-0 font-semibold">{formatCents(item.totalPrice, currency, locale)}</span>
                    </div>
                  )}
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11"
                      onClick={() => startEditing(index)}
                      aria-label={t('assign.editItem', { name: item.name })}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11"
                      onClick={() => deleteItem(index)}
                      aria-label={t('assign.removeItem', { name: item.name })}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                    {item.quantity > 1 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-11"
                        onClick={() => {
                          setSplittingItem(index);
                          setSplitQuantity('1');
                        }}
                        data-testid={'guest-split-btn-' + index}
                        aria-label={t('assign.split') + ' ' + item.name}
                      >
                        <Scissors className="size-4" />
                      </Button>
                    )}
                  </div>
                  {splittingItem === index && (
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Label htmlFor={'split-quantity-' + index}>{t('assign.splitOff')}</Label>
                      <Input
                        id={'split-quantity-' + index}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={item.quantity - 1}
                        value={splitQuantity}
                        onChange={(event) => setSplitQuantity(event.target.value)}
                        className="h-11 w-20 text-base"
                        data-testid={'guest-split-qty-' + index}
                      />
                      <Button
                        size="sm"
                        className="min-h-11"
                        disabled={
                          !Number.isSafeInteger(Number(splitQuantity)) ||
                          Number(splitQuantity) < 1 ||
                          Number(splitQuantity) >= item.quantity
                        }
                        onClick={() => handleSplitItem(index)}
                        data-testid={'guest-split-submit-' + index}
                      >
                        {t('assign.split')}
                      </Button>
                      <Button variant="ghost" size="sm" className="min-h-11" onClick={() => setSplittingItem(null)}>
                        {t('assign.cancel')}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
          {!addingItem && editingItem === null && splittingItem === null && (
            <div
              className="fixed right-0 bottom-0 left-0 z-10 max-h-[calc(100dvh-1rem)] overflow-y-auto overscroll-contain border-t bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
              data-testid="guest-assign-actions"
            >
              <div className="mx-auto max-w-lg space-y-2">
                <Button
                  className="h-14 w-full text-lg"
                  disabled={items.length === 0 || createClaimSession.isPending}
                  onClick={handleCreateReceipt}
                  data-testid="share-for-claiming-btn"
                >
                  {createClaimSession.isPending ? t('assign.creatingSession') : t('assign.createReceipt')}
                  <Users className="ml-2 size-5" />
                </Button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
