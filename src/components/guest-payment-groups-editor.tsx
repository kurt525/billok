'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { trpc } from '@/lib/trpc';

type Member = { id: string; name: string; paymentGroupRepresentativeId?: string };

/** 3.24.1.5: creator-only controls before finalization.
 * Grouping never changes the original receipt, diner IDs, parts or tips.
 * Each save replaces the whole group set through one serializable server write.
 */
export function GuestPaymentGroupsEditor({
  token,
  people,
  paidByIndex,
}: {
  token: string;
  people: Member[];
  paidByIndex: number;
}) {
  const t = useTranslations('split.claim');
  const utils = trpc.useUtils();
  const save = trpc.guest.setPaymentGroups.useMutation({
    onSuccess: async () => {
      await utils.guest.getSession.invalidate({ token });
      setLeader('');
      setMemberIds([]);
      toast.success(t('paymentGroupSaved'));
    },
    onError: () => {
      void utils.guest.getSession.invalidate({ token });
      toast.error(t('paymentGroupSaveFailed'));
    },
  });
  const [leader, setLeader] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const grouped = new Map<string, string[]>();
  for (const person of people) {
    if (!person.paymentGroupRepresentativeId) continue;
    const ids = grouped.get(person.paymentGroupRepresentativeId) ?? [];
    ids.push(person.id);
    grouped.set(person.paymentGroupRepresentativeId, ids);
  }
  const groups = [...grouped].map(([representativeId, memberIds]) => ({ representativeId, memberIds }));
  const free = people.filter((person, index) => index !== paidByIndex && !person.paymentGroupRepresentativeId);
  const actualLeader = free.some((person) => person.id === leader) ? leader : (free[0]?.id ?? '');
  const candidates = free.filter((person) => person.id !== actualLeader);
  const selected = memberIds.filter((id) => candidates.some((person) => person.id === id));

  const writeGroups = (next: typeof groups) => {
    if (!save.isPending) save.mutate({ token, groups: next });
  };

  return (
    <Card className="w-full min-w-0 max-w-full" data-testid="receipt-payment-groups-editor">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t('paymentGroupTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        <p className="text-sm text-muted-foreground">{t('paymentGroupIntro')}</p>
        {groups.map((group, idx) => (
          <div
            key={group.representativeId}
            className="min-w-0 space-y-2 rounded-lg border p-3"
            data-testid={'receipt-payment-group-' + idx}
          >
            <p className="break-words text-sm font-semibold">
              {t('paymentGroupResponsible')}: {people.find((person) => person.id === group.representativeId)?.name}
            </p>
            <p className="break-words text-xs text-muted-foreground">
              {group.memberIds.map((id) => people.find((person) => person.id === id)?.name).join(', ')}
            </p>
            <div className="flex min-w-0 flex-wrap gap-2">
              {group.memberIds
                .filter((id) => id !== group.representativeId)
                .map((id) => (
                  <Button
                    key={id}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11 min-w-0 max-w-full whitespace-normal break-words"
                    disabled={save.isPending}
                    onClick={() =>
                      writeGroups(groups.map((entry) => (entry === group ? { ...entry, representativeId: id } : entry)))
                    }
                    data-testid={'payment-group-leader-' + id}
                  >
                    {t('paymentGroupMakeResponsible', { name: people.find((p) => p.id === id)?.name ?? '' })}
                  </Button>
                ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 min-w-0 whitespace-normal"
                disabled={save.isPending}
                onClick={() => writeGroups(groups.filter((entry) => entry !== group))}
                data-testid={'payment-group-remove-' + idx}
              >
                {t('paymentGroupDissolve')}
              </Button>
            </div>
          </div>
        ))}
        {free.length >= 2 && (
          <div className="min-w-0 space-y-3 rounded-lg border p-3">
            <label htmlFor="payment-group-leader" className="block text-sm font-medium">
              {t('paymentGroupChooseResponsible')}
            </label>
            <select
              id="payment-group-leader"
              value={actualLeader}
              onChange={(event) => {
                setLeader(event.target.value);
                setMemberIds([]);
              }}
              className="h-11 w-full min-w-0 rounded-md border bg-background px-3 text-base"
              data-testid="payment-group-leader-select"
              disabled={save.isPending}
            >
              {free.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
            <p className="text-sm font-medium">{t('paymentGroupChooseMembers')}</p>
            <div className="space-y-2">
              {candidates.map((person) => (
                <label
                  key={person.id}
                  className="flex min-h-11 min-w-0 items-center gap-3 rounded-md border px-3 py-2 text-sm"
                  data-testid={'payment-group-member-' + person.id}
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(person.id)}
                    onChange={(event) =>
                      setMemberIds((before) =>
                        event.target.checked ? [...before, person.id] : before.filter((id) => id !== person.id),
                      )
                    }
                    disabled={save.isPending}
                    className="size-5 shrink-0"
                  />
                  <span className="min-w-0 break-words">{person.name}</span>
                </label>
              ))}
            </div>
            <Button
              type="button"
              className="min-h-11 w-full whitespace-normal"
              disabled={save.isPending || !actualLeader || selected.length === 0}
              onClick={() =>
                writeGroups([...groups, { representativeId: actualLeader, memberIds: [actualLeader, ...selected] }])
              }
              data-testid="payment-group-create"
            >
              {t('paymentGroupCreate')}
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t('paymentGroupDisclaimer')}</p>
      </CardContent>
    </Card>
  );
}
