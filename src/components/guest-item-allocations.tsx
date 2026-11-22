'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';
import { localizedTrpcError } from '@/lib/localized-trpc-error';
import { newRequestKey } from '@/lib/guest-session';
import { guestVisualColorStyle } from '@/lib/guest-visual-color';
import { canEditReceiptPerson } from '@/lib/guest-receipt-presentation';

type Person = { id: string; name: string; visualColorId?: number; paymentGroupRepresentativeId?: string };
type Allocation = { itemIndex: number; personIndices: number[]; partsByPersonId?: Record<string, number> | undefined };

export function GuestItemAllocations({
  token,
  itemIndex,
  people,
  assignment,
  knownParts,
  actorId,
  personToken,
  isCreator,
  disabled,
  open,
  onOpenChange,
  children,
}: {
  token: string;
  itemIndex: number;
  people: Person[];
  assignment?: Allocation;
  knownParts?: number | null;
  actorId: string | null;
  personToken: string | null;
  isCreator: boolean;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: ReactNode;
}) {
  const t = useTranslations('split.claim');
  const tc = useTranslations('common');
  const utils = trpc.useUtils();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const wasOpen = useRef(false);
  const currentCount = (person: Person, index: number) =>
    assignment?.personIndices.includes(index) ? (assignment.partsByPersonId?.[person.id] ?? 1) : 0;
  const canEdit = (person: Person) => canEditReceiptPerson(people, actorId, isCreator, person.id);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setDrafts(
        Object.fromEntries(
          people.map((person, index) => [
            person.id,
            String(assignment?.personIndices.includes(index) ? (assignment.partsByPersonId?.[person.id] ?? 1) : 0),
          ]),
        ),
      );
    }
    wasOpen.current = open;
    // Deliberately only reset on closed-to-open, never clobber typed values
    // after an SSE/React Query refetch while the editor is in use.
  }, [open, people, assignment]);

  const update = trpc.guest.setReceiptItemParts.useMutation({
    onSuccess: async () => {
      await utils.guest.getSession.invalidate({ token });
      onOpenChange(false);
    },
    onError: (error) => {
      void utils.guest.getSession.invalidate({ token });
      toast.error(localizedTrpcError(error, tc('errors.generic')));
    },
  });
  const blocked = disabled || update.isPending;
  const countDraft = people.map((person, index) => ({
    person,
    index,
    value: drafts[person.id] ?? String(currentCount(person, index)),
  }));
  const invalid = countDraft.some(
    ({ person, value }) =>
      canEdit(person) && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 10000),
  );
  const changes = countDraft
    .filter(({ person, index, value }) => canEdit(person) && Number(value) !== currentCount(person, index))
    .map(({ person, value }) => ({ personId: person.id, parts: Number(value) }));
  const projectedTotal = countDraft.reduce(
    (sum, { person, index, value }) => sum + (canEdit(person) ? Number(value) || 0 : currentCount(person, index)),
    0,
  );
  const overOriginal = knownParts != null && projectedTotal > knownParts;
  const save = (next: { personId: string; parts: number }[]) => {
    if (blocked || next.length === 0) return;
    update.mutate({
      token,
      ...(personToken ? { personToken } : {}),
      itemIndex,
      changes: next,
      requestKey: newRequestKey(),
    });
  };

  return (
    <div className="mt-2 min-w-0 space-y-2" onClick={(event) => event.stopPropagation()}>
      <div className="flex min-w-0 flex-wrap gap-2" data-testid={'dish-people-' + itemIndex}>
        {people.map((person, index) => {
          const parts = currentCount(person, index);
          const editable = canEdit(person);
          return (
            <button
              type="button"
              key={person.id}
              data-testid={'dish-person-' + itemIndex + '-' + index}
              aria-label={person.name + ', ' + parts + ' ' + t('allocatedPartsUnit')}
              aria-pressed={parts > 0}
              style={editable ? guestVisualColorStyle(person, index) : undefined}
              disabled={blocked || !editable || parts > 1}
              onClick={() => save([{ personId: person.id, parts: parts === 0 ? 1 : 0 }])}
              className={
                'relative inline-flex min-h-11 min-w-0 max-w-full items-center rounded-xl border px-3 py-2 text-sm font-medium ' +
                'text-foreground shadow-sm [overflow-wrap:anywhere] disabled:cursor-default ' +
                'border-border bg-background' +
                (!editable ? ' opacity-65' : '')
              }
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">{person.name}</span>
              {parts > 0 && (
                <sup
                  className="relative -top-1 ml-1 inline-flex min-h-5 min-w-5 shrink-0 items-center justify-center rounded-md border border-slate-500 bg-white px-1 text-[12px] font-bold leading-none text-slate-950 dark:border-slate-300 dark:bg-slate-950 dark:text-white"
                  data-testid={'dish-parts-count-' + itemIndex + '-' + index}
                  aria-hidden="true"
                >
                  {parts}
                </sup>
              )}
            </button>
          );
        })}
      </div>
      {open && (
        <div
          className="min-w-0 space-y-3 rounded-lg border bg-background p-3"
          data-testid={'dish-parts-editor-' + itemIndex}
        >
          <p className="text-sm font-semibold">{t('partsForPeople')}</p>
          <div className="space-y-2">
            {countDraft.map(({ person, index, value }) => (
              <label key={person.id} className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{person.name}</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  step={1}
                  min={0}
                  max={10000}
                  className="h-11 w-24 min-w-0 shrink-0 text-base"
                  aria-label={t('partsForPerson', { name: person.name })}
                  data-testid={'dish-parts-input-' + itemIndex + '-' + index}
                  value={value}
                  disabled={blocked || !canEdit(person)}
                  onChange={(event) => setDrafts((prev) => ({ ...prev, [person.id]: event.target.value }))}
                />
              </label>
            ))}
          </div>
          {overOriginal && (
            <p className="text-xs text-destructive" role="alert">
              {t('knownPartsOverclaimed', { count: projectedTotal - knownParts! })}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              data-testid={'dish-parts-save-' + itemIndex}
              disabled={blocked || invalid || overOriginal || changes.length === 0}
              onClick={() => save(changes)}
              className="min-h-11"
            >
              {update.isPending ? t('saving') : t('partsSave')}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              data-testid={'dish-parts-cancel-' + itemIndex}
              onClick={() => onOpenChange(false)}
            >
              {t('cancelButton')}
            </Button>
          </div>
          {children}
        </div>
      )}
    </div>
  );
}
