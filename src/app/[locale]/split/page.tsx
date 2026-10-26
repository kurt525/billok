'use client';

import { useState, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { formatCents, centsToDecimal, parseToCents, isValidMoneyInput } from '@/lib/money';
import { parseReceiptQuantity } from '@/lib/receipt-quantity';
import { calculateSplitTotals } from '@/lib/split-calculator';
import { canStoreClaimIdentity, setStoredClaimIdentity } from '@/lib/guest-session';
import { MAX_GUEST_NAME_LENGTH } from '@/lib/guest-name-limit';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Plus, Trash2, Check, Users, ArrowLeft, ArrowRight, Share2, Pencil, Scissors } from 'lucide-react';
import { toast } from 'sonner';
import { chipLabels, getInitials } from '@/lib/avatar';

type Step = 'people' | 'assign';

type GuestItem = {
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
};

type ExtractedData = {
  merchantName?: string;
  date?: string;
  subtotal: number;
  tax: number;
  tip: number;
  total: number;
  currency: string;
};

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
  return <AuthenticatedGuestSplitPage />;
}

function AuthenticatedGuestSplitPage() {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('split');
  const tc = useTranslations('common');
  const [step, setStep] = useState<Step>('people');

  // Data
  const [items, setItems] = useState<GuestItem[]>([]);
  const [receiptName, setReceiptName] = useState('');
  const [people, setPeople] = useState<string[]>(['']); // start with one empty name
  // Stable keys for the (removable) person rows so deleting a row doesn't
  // re-key the rows below it. Kept in lockstep with `people`.
  const personKeyCounter = useRef(1);
  const [personKeys, setPersonKeys] = useState<number[]>([0]);
  const [assignments, setAssignments] = useState<Record<number, Set<number>>>({}); // itemIdx -> Set<personIdx>
  const [paidByIndex, setPaidByIndex] = useState(0);
  const [tipOverride, setTipOverride] = useState('');

  // Editing
  const [editingItem, setEditingItem] = useState<number | null>(null);
  const [editValues, setEditValues] = useState({ name: '', quantity: '1', totalPrice: '' });
  const [addingItem, setAddingItem] = useState(false);
  const [newItem, setNewItem] = useState({ name: '', quantity: '1', totalPrice: '' });

  // Splitting
  const [splittingIndex, setSplittingIndex] = useState<number | null>(null);
  const [splitQuantity, setSplitQuantity] = useState('');

  // tRPC
  const createSplit = trpc.guest.createSplit.useMutation();
  const createClaimSession = trpc.guest.createClaimSession.useMutation();

  function removePerson(idx: number) {
    setPeople((p) => p.filter((_, i) => i !== idx));
    setPersonKeys((keys) => keys.filter((_, i) => i !== idx));
    // Clean up assignments
    setAssignments((prev) => {
      const next: Record<number, Set<number>> = {};
      for (const [itemIdx, personSet] of Object.entries(prev)) {
        const newSet = new Set<number>();
        for (const pIdx of personSet) {
          if (pIdx < idx) newSet.add(pIdx);
          else if (pIdx > idx) newSet.add(pIdx - 1);
        }
        if (newSet.size > 0) next[parseInt(itemIdx)] = newSet;
      }
      return next;
    });
    if (paidByIndex >= idx && paidByIndex > 0) {
      setPaidByIndex((p) => p - 1);
    }
  }

  function updatePersonName(idx: number, name: string) {
    setPeople((p) => p.map((n, i) => (i === idx ? name : n)));
  }

  // Assignment
  // Note (Finding #29): toggleAssignment and assignAllToEveryone are intentionally
  // duplicated from item-assignment.tsx. This component uses Record<number, Set<number>>
  // (index-based) while item-assignment uses Record<string, Set<string>> (id-based).
  // The different key types make a shared abstraction more complex than the duplication.
  function toggleAssignment(itemIdx: number, personIdx: number) {
    setAssignments((prev) => {
      const next = { ...prev };
      const current = new Set(next[itemIdx] ?? []);
      if (current.has(personIdx)) {
        current.delete(personIdx);
      } else {
        current.add(personIdx);
      }
      next[itemIdx] = current;
      return next;
    });
  }

  function assignAllToEveryone() {
    const validIndices = people
      .map((name, idx) => ({ name, idx }))
      .filter((p) => p.name.trim())
      .map((p) => p.idx);
    const next: Record<number, Set<number>> = {};
    for (let i = 0; i < items.length; i++) {
      next[i] = new Set(validIndices);
    }
    setAssignments(next);
  }

  // Item editing
  function startEditing(idx: number) {
    const item = items[idx];
    if (!item) return;
    setEditingItem(idx);
    setEditValues({
      name: item.name,
      quantity: String(item.quantity),
      totalPrice: centsToDecimal(item.totalPrice),
    });
  }

  function saveEdit() {
    if (editingItem === null) return;
    const trimmedName = editValues.name.trim();
    if (!trimmedName) {
      toast.error(t('assign.validationNameRequired'));
      return;
    }
    const totalPrice = parseToCents(editValues.totalPrice);
    if (totalPrice <= 0) {
      toast.error(t('assign.validationPricePositive'));
      return;
    }
    const quantity = parseReceiptQuantity(editValues.quantity);
    if (quantity === null) {
      toast.error(t('assign.validationQtyPositive'));
      return;
    }
    setItems((prev) =>
      prev.map((item, i) =>
        i === editingItem
          ? { name: trimmedName, quantity, unitPrice: Math.round(totalPrice / quantity), totalPrice }
          : item,
      ),
    );
    setEditingItem(null);
  }

  function deleteItem(idx: number) {
    setItems((prev) => prev.filter((_, i) => i !== idx));
    setAssignments((prev) => {
      const next: Record<number, Set<number>> = {};
      for (const [key, val] of Object.entries(prev)) {
        const k = parseInt(key);
        if (k < idx) next[k] = val;
        else if (k > idx) next[k - 1] = val;
      }
      return next;
    });
    // Shift index-based UI state so the edit/split forms don't retarget the
    // wrong item when an item above them is deleted.
    setEditingItem((prev) => (prev === null || prev === idx ? null : prev > idx ? prev - 1 : prev));
    setSplittingIndex((prev) => (prev === null || prev === idx ? null : prev > idx ? prev - 1 : prev));
  }

  function handleAddItem(e: React.FormEvent) {
    e.preventDefault();
    const totalPrice = parseToCents(newItem.totalPrice);
    const quantity = parseReceiptQuantity(newItem.quantity);
    if (quantity === null) {
      toast.error(t('assign.validationQtyPositive'));
      return;
    }
    if (!newItem.name || totalPrice <= 0) return;
    setItems((prev) => [
      ...prev,
      {
        name: newItem.name,
        quantity,
        unitPrice: Math.round(totalPrice / quantity),
        totalPrice,
      },
    ]);
    setAddingItem(false);
    setNewItem({ name: '', quantity: '1', totalPrice: '' });
  }

  // Split item into two rows
  function handleSplitItem(index: number) {
    const qty = Number(splitQuantity);
    const item = items[index];
    if (!item || !Number.isSafeInteger(qty) || qty < 1 || qty >= item.quantity) return;

    const maxNewTotal = item.totalPrice - 1;
    if (maxNewTotal <= 0) return;

    const newTotalPrice = Math.min(item.unitPrice * qty, maxNewTotal);
    const remainingQty = item.quantity - qty;
    const remainingTotalPrice = item.totalPrice - newTotalPrice;

    if (newTotalPrice <= 0 || remainingTotalPrice <= 0) return;

    const updated = [...items];
    updated[index] = { ...item, quantity: remainingQty, totalPrice: remainingTotalPrice };
    updated.splice(index + 1, 0, {
      name: item.name,
      quantity: qty,
      unitPrice: item.unitPrice,
      totalPrice: newTotalPrice,
    });
    setItems(updated);

    // Shift assignments: indices after the insertion point need to be incremented
    const newAssignments: Record<number, Set<number>> = {};
    for (const [key, value] of Object.entries(assignments)) {
      const k = parseInt(key);
      if (k > index) {
        newAssignments[k + 1] = value;
      } else {
        newAssignments[k] = value;
      }
    }
    setAssignments(newAssignments);

    // Shift index-based UI state so edits don't target the wrong item
    setEditingItem((prev) => (prev !== null && prev > index ? prev + 1 : prev));
    setSplittingIndex(null);
  }

  // BillOK manual receipts: no photo, OCR provider, or external currency lookup.
  const subtotal = items.reduce((sum, item) => sum + item.totalPrice, 0);
  const extracted: ExtractedData = {
    merchantName: receiptName.trim() || t('manual.defaultTitle'),
    subtotal,
    tax: 0,
    tip: 0,
    total: subtotal,
    currency: 'RUB',
  };

  // Calculate totals
  const parsedTip = parseToCents(tipOverride);
  const tip =
    tipOverride !== '' && isValidMoneyInput(tipOverride) && parsedTip >= 0 ? parsedTip : (extracted?.tip ?? 0);
  const currency = 'RUB';

  const getPerPersonTotals = () => {
    if (items.length === 0) return [];
    const assignmentList = Object.entries(assignments)
      .filter(([, s]) => s.size > 0)
      .map(([itemIdx, personSet]) => ({
        itemIndex: parseInt(itemIdx),
        personIndices: Array.from(personSet),
      }));

    return calculateSplitTotals({
      items,
      assignments: assignmentList,
      tax: extracted.tax,
      tip,
      peopleCount: people.length,
    });
  };

  const perPersonTotals = step === 'assign' ? getPerPersonTotals() : [];
  const validPeople = people.filter((n) => n.trim().length > 0);
  const validPeopleIndices = new Set(people.map((n, i) => (n.trim() ? i : -1)).filter((i) => i >= 0));
  const assignedCount = Object.values(assignments).filter((s) => {
    return Array.from(s).some((pi) => validPeopleIndices.has(pi));
  }).length;
  const allAssigned = assignedCount === items.length && items.length > 0;

  async function handleCreateSplit() {
    if (!allAssigned || validPeople.length < 1) return;

    // Build index mapping from unfiltered people → filtered validPeople
    const indexMap = new Map<number, number>();
    let validIdx = 0;
    for (const [i, person] of people.entries()) {
      if (person.trim()) {
        indexMap.set(i, validIdx++);
      }
    }

    const assignmentList = Object.entries(assignments)
      .filter(([, s]) => s.size > 0)
      .map(([itemIdx, personSet]) => ({
        itemIndex: parseInt(itemIdx),
        personIndices: Array.from(personSet)
          .filter((pi) => indexMap.has(pi))
          .map((pi) => indexMap.get(pi)!),
      }))
      .filter((a) => a.personIndices.length > 0);

    const remappedPaidBy = indexMap.get(paidByIndex) ?? 0;

    try {
      const result = await createSplit.mutateAsync({
        receiptData: { ...extracted, tip },
        items,
        people: validPeople.map((n) => ({ name: n })),
        assignments: assignmentList,
        paidByIndex: remappedPaidBy,
        tipOverride: tipOverride !== '' && isValidMoneyInput(tipOverride) && parsedTip >= 0 ? parsedTip : undefined,
      });
      router.push(`/split/${result.shareToken}`);
    } catch {
      toast.error(t('assign.createSplitFailed'));
    }
  }

  async function handleShareForClaiming() {
    if (items.length === 0 || validPeople.length < 1) return;

    // `validPeople.length < 1` already returned above, so index 0 always
    // exists; the `?? ""` is unreachable but keeps the type `string`.
    const fallbackName = validPeople[0] ?? '';

    try {
      const result = await createClaimSession.mutateAsync({
        receiptData: { ...extracted, tip },
        items,
        people: validPeople,
        // The manually chosen payer also represents the guest who creates the session.
        creatorName: people[paidByIndex]?.trim() || fallbackName,
        paidByName: people[paidByIndex]?.trim() || fallbackName,
        // Without storage the creator joins by name on the claim page, as before
        joinCreator: canStoreClaimIdentity(),
      });
      if (result.creator) {
        setStoredClaimIdentity(result.shareToken, {
          name: result.creator.name,
          personToken: result.creator.personToken,
        });
      }
      router.push(`/split/${result.shareToken}/claim`);
    } catch {
      toast.error(t('assign.createSessionFailed'));
    }
  }

  const initials = getInitials;
  // First names, or whole names where two people share one (#277)
  const labels = chipLabels(people);

  return (
    <div className={step === 'assign' ? 'space-y-6 pb-56' : 'space-y-6 pb-32'}>
      {/* Step: People */}
      {step === 'people' && (
        <div className="space-y-6">
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
              onChange={(e) => setReceiptName(e.target.value)}
              placeholder={t('manual.defaultTitle')}
              className="h-12"
              data-testid="manual-receipt-name"
            />
          </div>

          {/* Person list */}
          <div className="space-y-3">
            {people.map((name, idx) => (
              <div key={personKeys[idx] ?? idx} className="flex min-w-0 items-center gap-2">
                <Avatar className="h-10 w-10 shrink-0">
                  <AvatarFallback className="text-sm bg-primary/10 text-primary">
                    {name.trim() ? initials(name) : `P${idx + 1}`}
                  </AvatarFallback>
                </Avatar>
                <Input
                  value={name}
                  maxLength={MAX_GUEST_NAME_LENGTH}
                  onChange={(e) => updatePersonName(idx, e.target.value)}
                  placeholder={t('people.personPlaceholder', { index: idx + 1 })}
                  className="h-12 min-w-0 flex-1 text-base"
                  autoComplete="off"
                  data-testid={`person-input-${idx}`}
                />
                {people.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('people.removePerson')}
                    onClick={() => removePerson(idx)}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>

          <Button
            variant="outline"
            className="w-full h-12"
            onClick={() => {
              setPeople((p) => [...p, '']);
              setPersonKeys((keys) => [...keys, personKeyCounter.current++]);
            }}
            data-testid="add-person-btn"
          >
            <Plus className="mr-2 h-4 w-4" />
            {t('people.addPerson')}
          </Button>

          {/* Who paid? */}
          <div className="space-y-2">
            <Label htmlFor="who-paid">{t('people.whoPaid')}</Label>
            <select
              id="who-paid"
              value={paidByIndex}
              onChange={(e) => setPaidByIndex(parseInt(e.target.value))}
              className="flex h-12 w-full rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm"
            >
              {people.map((name, idx) => (
                <option key={idx} value={idx}>
                  {name.trim() || t('people.personPlaceholder', { index: idx + 1 })}
                </option>
              ))}
            </select>
          </div>

          {/* Next button - sticky bottom */}
          <div className="fixed right-0 bottom-0 left-0 max-h-[calc(100dvh-1rem)] overflow-y-auto overscroll-contain border-t bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <div className="mx-auto max-w-lg space-y-3">
              <Button
                className="w-full h-14 text-lg"
                disabled={validPeople.length < 1}
                onClick={() => setStep('assign')}
                data-testid="next-assign-btn"
              >
                {t('people.nextAssign')}
                <ArrowRight className="ml-2 h-5 w-5" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Step: Assign */}
      {step === 'assign' && (
        <div className="space-y-4" data-testid="guest-assign-step">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" aria-label={tc('actions.back')} onClick={() => setStep('people')}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h2 className="text-xl font-bold">{t('assign.title')}</h2>
          </div>

          {/* Receipt summary */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{extracted.merchantName ?? t('assign.receiptSummary')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('assign.subtotal')}</span>
                <span>{formatCents(extracted.subtotal, currency, locale)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('assign.tax')}</span>
                <span>{formatCents(extracted.tax, currency, locale)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('assign.tip')}</span>
                <span>{formatCents(tip, currency, locale)}</span>
              </div>
              <Separator />
              <div className="flex justify-between font-semibold">
                <span>{t('assign.total')}</span>
                <span>{formatCents(extracted.subtotal + extracted.tax + tip, currency, locale)}</span>
              </div>
            </CardContent>
          </Card>

          {/* Tip override */}
          <div className="space-y-2">
            <Label htmlFor="guest-tip">{t('assign.tipOverrideLabel')}</Label>
            <Input
              id="guest-tip"
              type="text"
              inputMode="decimal"
              placeholder={t('assign.tipDetected', { amount: formatCents(extracted.tip, currency, locale) })}
              value={tipOverride}
              onChange={(e) => setTipOverride(e.target.value)}
              className="h-12"
            />
          </div>

          {/* Quick actions */}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 whitespace-normal"
              onClick={assignAllToEveryone}
              data-testid="guest-split-all-btn"
            >
              <Users className="mr-2 h-4 w-4" />
              {t('assign.splitAllEqually')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 whitespace-normal"
              onClick={() => setAddingItem(true)}
              data-testid="guest-add-item-btn"
            >
              <Plus className="mr-2 h-4 w-4" />
              {t('assign.addItem')}
            </Button>
          </div>

          {items.length === 0 && !addingItem && (
            <p
              className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground"
              data-testid="manual-no-items"
            >
              {t('manual.addFirstItem')}
            </p>
          )}

          {/* Add new item form */}
          {addingItem && (
            <Card className="border-primary/50">
              <CardContent className="py-3">
                <form onSubmit={handleAddItem} className="space-y-2">
                  <Input
                    placeholder={t('assign.itemNamePlaceholder')}
                    value={newItem.name}
                    onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))}
                    required
                    className="h-12"
                  />
                  <div className="grid min-w-0 grid-cols-2 gap-2">
                    <Input
                      type="number"
                      inputMode="numeric"
                      placeholder={t('assign.qtyPlaceholder')}
                      value={newItem.quantity}
                      onChange={(e) => setNewItem((p) => ({ ...p, quantity: e.target.value }))}
                      className="h-12 min-w-0"
                      min="1"
                    />
                    <Input
                      type="text"
                      inputMode="decimal"
                      placeholder={t('assign.pricePlaceholder')}
                      value={newItem.totalPrice}
                      onChange={(e) => setNewItem((p) => ({ ...p, totalPrice: e.target.value }))}
                      className="h-12 min-w-0"
                      required
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" className="min-h-11" data-testid="guest-add-item-submit">
                      {t('assign.add')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="min-h-11"
                      onClick={() => setAddingItem(false)}
                    >
                      {t('assign.cancel')}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}

          {/* Items with assignment */}
          <div className="space-y-2">
            <Label>{t('assign.tapToAssign', { assigned: assignedCount, total: items.length })}</Label>
            {items.map((item, itemIdx) => {
              const assigned = assignments[itemIdx] ?? new Set();
              const isEditing = editingItem === itemIdx;

              return (
                <Card
                  key={itemIdx}
                  className={assigned.size === 0 ? 'border-amber-300' : ''}
                  data-testid={`guest-item-card-${itemIdx}`}
                >
                  <CardContent className="py-3">
                    {isEditing ? (
                      <div className="mb-2 space-y-2">
                        <Input
                          value={editValues.name}
                          onChange={(e) => setEditValues((p) => ({ ...p, name: e.target.value }))}
                          placeholder={t('assign.itemNamePlaceholder')}
                          className="h-12"
                        />
                        <div className="grid min-w-0 grid-cols-2 gap-2">
                          <Input
                            type="number"
                            inputMode="numeric"
                            value={editValues.quantity}
                            onChange={(e) => setEditValues((p) => ({ ...p, quantity: e.target.value }))}
                            className="h-12 min-w-0"
                            placeholder={t('assign.qtyPlaceholder')}
                            min="1"
                          />
                          <Input
                            type="text"
                            inputMode="decimal"
                            value={editValues.totalPrice}
                            onChange={(e) => setEditValues((p) => ({ ...p, totalPrice: e.target.value }))}
                            className="h-12 min-w-0"
                            placeholder={t('assign.pricePlaceholder')}
                          />
                        </div>
                        <div className="flex gap-1">
                          <Button type="button" size="sm" className="min-h-11" onClick={saveEdit}>
                            {t('assign.save')}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="min-h-11"
                            onClick={() => setEditingItem(null)}
                          >
                            {t('assign.cancel')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-1">
                          <span className="min-w-0 break-words font-medium">{item.name}</span>
                          {item.quantity > 1 && <span className="text-xs text-muted-foreground">x{item.quantity}</span>}
                          <button
                            type="button"
                            onClick={() => startEditing(itemIdx)}
                            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                            aria-label={t('assign.editItem', { name: item.name })}
                            title={t('assign.editItem', { name: item.name })}
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteItem(itemIdx)}
                            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-destructive"
                            aria-label={t('assign.removeItem', { name: item.name })}
                            title={t('assign.removeItem', { name: item.name })}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                          {item.quantity > 1 && (
                            <button
                              type="button"
                              onClick={() => {
                                setSplittingIndex(itemIdx);
                                setSplitQuantity('1');
                              }}
                              className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                              title={t('assign.split')}
                              aria-label={t('assign.split') + ` ${item.name}`}
                              data-testid={`guest-split-btn-${itemIdx}`}
                            >
                              <Scissors className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                        <span className="font-semibold">{formatCents(item.totalPrice, currency, locale)}</span>
                      </div>
                    )}
                    {/* Inline split form */}
                    {splittingIndex === itemIdx &&
                      (() => {
                        const parsed = Number(splitQuantity);
                        const validQty = Number.isSafeInteger(parsed) && parsed >= 1 && parsed < item.quantity;
                        return (
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <span className="text-xs text-muted-foreground">{t('assign.splitOff')}</span>
                            <Input
                              type="number"
                              min={1}
                              max={item.quantity - 1}
                              value={splitQuantity}
                              onChange={(e) => setSplitQuantity(e.target.value)}
                              inputMode="numeric"
                              className="h-11 w-20 text-base"
                              data-testid={`guest-split-qty-${itemIdx}`}
                            />
                            <span className="text-xs text-muted-foreground">
                              {t('assign.splitOfTotal', { total: item.quantity })}
                            </span>
                            <Button
                              type="button"
                              size="sm"
                              className="min-h-11"
                              disabled={!validQty}
                              onClick={() => handleSplitItem(itemIdx)}
                              data-testid={`guest-split-submit-${itemIdx}`}
                            >
                              {t('assign.split')}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="min-h-11"
                              onClick={() => setSplittingIndex(null)}
                            >
                              {t('assign.cancel')}
                            </Button>
                          </div>
                        );
                      })()}
                    {/* Person toggle buttons */}
                    <div className="flex flex-wrap gap-1.5">
                      {people.map((name, personIdx) => {
                        if (!name.trim()) return null;
                        const isAssigned = assigned.has(personIdx);
                        return (
                          <button
                            key={personIdx}
                            type="button"
                            onClick={() => toggleAssignment(itemIdx, personIdx)}
                            className={`flex min-h-11 max-w-full items-center gap-1 rounded-full px-3 py-2 text-sm transition-colors ${
                              isAssigned
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-muted text-muted-foreground hover:bg-muted/80'
                            }`}
                          >
                            <Avatar className="h-5 w-5">
                              <AvatarFallback className="text-[9px]">{initials(name)}</AvatarFallback>
                            </Avatar>
                            <span
                              data-testid="chip-label"
                              className="min-w-0 text-left [overflow-wrap:anywhere]"
                              title={name.trim()}
                            >
                              {labels[personIdx]}
                            </span>
                            {isAssigned && <Check className="h-3 w-3" />}
                          </button>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Per-person summary */}
          {perPersonTotals.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t('assign.perPersonTotals')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {perPersonTotals.map((pt) => (
                  <div key={pt.personIndex} className="flex justify-between text-sm">
                    <span>
                      {people[pt.personIndex]?.trim() || t('people.personPlaceholder', { index: pt.personIndex + 1 })}
                    </span>
                    <span className="font-medium">{formatCents(pt.total, currency, locale)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Next button - sticky bottom */}
          <div className="fixed right-0 bottom-0 left-0 border-t bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <div className="mx-auto max-w-lg space-y-3">
              <Button
                className="w-full h-14 text-lg"
                disabled={!allAssigned || createSplit.isPending}
                onClick={handleCreateSplit}
                data-testid="create-split-btn"
              >
                {createSplit.isPending
                  ? t('assign.creatingSplit')
                  : !allAssigned
                    ? t('assign.assignAllItems', { remaining: items.length - assignedCount })
                    : t('assign.createSplitButton')}
                {allAssigned && !createSplit.isPending && <Share2 className="ml-2 h-5 w-5" />}
              </Button>
              <Button
                variant="outline"
                className="w-full h-12"
                disabled={items.length === 0 || validPeople.length < 1 || createClaimSession.isPending}
                onClick={handleShareForClaiming}
                data-testid="share-for-claiming-btn"
              >
                {createClaimSession.isPending ? t('assign.creatingSession') : t('assign.shareForClaiming')}
                {!createClaimSession.isPending && <Users className="ml-2 h-5 w-5" />}
              </Button>
              <p className="text-xs text-center text-muted-foreground">{t('assign.shareHint')}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
