'use client';

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { trpc } from '@/lib/trpc';
import { GUEST_OWNER_COLOR_ID } from '@/lib/guest-visual-color';
import { receiptGroupsRevision } from '@/lib/receipt-payment-groups';
import { MAX_GUEST_NAME_LENGTH } from '@/lib/guest-name-limit';

type Member = {
  id: string;
  name: string;
  paymentGroupRepresentativeId?: string;
  visualColorId?: number;
  isRegistered?: boolean;
};

/** Stable while representative changes: group tab identity is its member set.
 * Never index group writes by a display number or mutate stale members.
 */
export function groupMemberKey(ids: readonly string[]): string {
  return [...ids].sort().join('|');
}

export function GuestPaymentGroupsEditor({
  token,
  people,
  paidByIndex,
  actorId,
  actorToken,
  isCreator,
  organizerPersonId,
  editable,
  children,
}: {
  token: string;
  people: Member[];
  paidByIndex: number;
  actorId: string | null;
  actorToken: string | null;
  isCreator: boolean;
  organizerPersonId: string | null;
  editable: boolean;
  children: ReactNode;
}) {
  const t = useTranslations('split.claim');
  const utils = trpc.useUtils();
  const [active, setActive] = useState('all');
  const [leader, setLeader] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const requestedTab = useRef('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const grouped = new Map<string, string[]>();
  for (const person of people) {
    if (!person.paymentGroupRepresentativeId) continue;
    const ids = grouped.get(person.paymentGroupRepresentativeId) ?? [];
    ids.push(person.id);
    grouped.set(person.paymentGroupRepresentativeId, ids);
  }
  const groups = [...grouped].map(([representativeId, memberIds]) => ({
    representativeId,
    memberIds,
    key: groupMemberKey(memberIds),
  }));
  const free = people.filter((person, index) => index !== paidByIndex && !person.paymentGroupRepresentativeId);
  const actualLeader = free.some((person) => person.id === leader) ? leader : (free[0]?.id ?? '');
  const candidates = free.filter((person) => person.id !== actualLeader);
  const selected = memberIds.filter((id) => candidates.some((person) => person.id === id));
  const canCreate = isCreator && editable && free.length >= 2;
  const tabKeys = ['all', ...groups.map((group) => 'group:' + group.key), ...(canCreate ? ['create'] : [])];
  const visibleTab = tabKeys.includes(active) ? active : 'all';
  const save = trpc.guest.setPaymentGroups.useMutation({
    onSuccess: async () => {
      await utils.guest.getSession.invalidate({ token });
      setLeader('');
      setMemberIds([]);
      setActive(requestedTab.current);
      setEditingId(null);
      toast.success(t('paymentGroupSaved'));
    },
    onError: () => {
      void utils.guest.getSession.invalidate({ token });
      setActive('all');
      toast.error(t('paymentGroupSaveFailed'));
    },
  });
  const rename = trpc.guest.editPersonName.useMutation({
    onSuccess: async () => {
      await utils.guest.getSession.invalidate({ token });
      setEditingId(null);
    },
    onError: () => toast.error(t('paymentGroupSaveFailed')),
  });
  const writeGroups = (next: { representativeId: string; memberIds: string[] }[], nextTab: string) => {
    if (!save.isPending && isCreator && editable) {
      requestedTab.current = nextTab;
      save.mutate({ token, groups: next, expectedGroupRevision: receiptGroupsRevision(groups) });
    }
  };
  const tabs = tabKeys;
  const keyNavigation = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    const index = tabs.indexOf(key);
    let target = index;
    if (event.key === 'ArrowRight') target = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') target = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = tabs.length - 1;
    else return;
    event.preventDefault();
    const next = tabs[target]!;
    setActive(next);
    const parent = event.currentTarget.parentElement;
    const buttons = parent?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[target]?.focus();
  };
  const isGroupLeader = (representativeId: string) => actorId === representativeId && !!actorToken;
  const canRename = (person: Member, representativeId: string) =>
    editable &&
    ((isCreator && (!person.isRegistered || person.id === actorId)) ||
      person.id === actorId ||
      (isGroupLeader(representativeId) &&
        person.id !== organizerPersonId &&
        person.visualColorId !== GUEST_OWNER_COLOR_ID));

  return (
    <div className="w-full min-w-0 space-y-4" data-testid="receipt-payment-groups-editor">
      <div
        className="w-full min-w-0 overflow-x-auto overscroll-x-contain rounded-lg border"
        role="tablist"
        aria-label={t('peopleInSession', { count: people.length })}
        data-testid="people-subtabs"
      >
        <div className="flex min-w-max gap-1 p-1">
          {tabs.map((key) => {
            const number = groups.findIndex((group) => key === 'group:' + group.key);
            const name =
              key === 'all'
                ? t('peopleSubtabAll')
                : key === 'create'
                  ? t('peopleSubtabCreate')
                  : t('peopleSubtabGroup', { number: number + 1 });
            const tabId = 'people-subtab-' + (key === 'all' ? 'all' : key === 'create' ? 'create' : 'group-' + number);
            return (
              <button
                key={key}
                type="button"
                id={tabId}
                role="tab"
                aria-selected={visibleTab === key}
                aria-controls={
                  'people-subpanel-' + (key === 'all' ? 'all' : key === 'create' ? 'create' : 'group-' + number)
                }
                tabIndex={visibleTab === key ? 0 : -1}
                className={
                  'min-h-11 shrink-0 rounded-md px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ' +
                  (visibleTab === key ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted')
                }
                onClick={() => {
                  setActive(key);
                  setEditingId(null);
                }}
                onKeyDown={(event) => keyNavigation(event, key)}
                data-testid={
                  key === 'all'
                    ? 'people-subtab-all'
                    : key === 'create'
                      ? 'people-subtab-create'
                      : 'people-subtab-group-' + number
                }
              >
                {name}
              </button>
            );
          })}
        </div>
      </div>
      <div
        role="tabpanel"
        id="people-subpanel-all"
        aria-labelledby="people-subtab-all"
        hidden={visibleTab !== 'all'}
        className="min-w-0 space-y-6"
        data-testid="people-subpanel-all"
      >
        {children}
      </div>
      {groups.map((group, number) => {
        const memberRows = group.memberIds
          .map((id) => people.find((p) => p.id === id))
          .filter((person): person is Member => !!person);
        const ordered = [
          ...memberRows.filter((person) => person.id === group.representativeId),
          ...memberRows.filter((person) => person.id !== group.representativeId),
        ];
        const chosen = visibleTab === 'group:' + group.key;
        return (
          <div
            key={group.key}
            role="tabpanel"
            hidden={!chosen}
            aria-labelledby={'people-subtab-group-' + number}
            id={'people-subpanel-group-' + number}
            className="min-w-0 space-y-3"
            data-testid={'receipt-payment-group-' + number}
          >
            <Card className="min-w-0">
              <CardContent className="space-y-3 py-4">
                <p className="text-sm font-semibold">{t('peopleSubtabGroup', { number: number + 1 })}</p>
                <p className="text-xs text-muted-foreground">
                  {t('paymentGroupResponsible')}: {people.find((p) => p.id === group.representativeId)?.name}
                </p>
                {ordered.map((person) => (
                  <div
                    key={person.id}
                    className="min-w-0 rounded-md border p-3"
                    data-testid={'payment-group-person-' + person.id}
                  >
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <span className="min-w-0 break-words text-sm font-medium">
                        {person.name}
                        {person.id === actorId ? ' ' + t('you') : ''}
                      </span>
                      {canRename(person, group.representativeId) && editingId !== person.id && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-11 shrink-0"
                          onClick={() => {
                            setEditingId(person.id);
                            setEditName(person.name);
                          }}
                          data-testid={'group-edit-person-' + person.id}
                        >
                          {t('editName')}
                        </Button>
                      )}
                    </div>
                    {editingId === person.id && canRename(person, group.representativeId) && (
                      <form
                        className="mt-2 flex min-w-0 flex-wrap gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (!editName.trim() || rename.isPending) return;
                          rename.mutate({
                            token,
                            ...(actorToken ? { personToken: actorToken } : {}),
                            targetId: person.id,
                            newName: editName.trim(),
                          });
                        }}
                      >
                        <input
                          className="min-h-11 min-w-0 flex-1 rounded-md border bg-background px-3 text-base"
                          value={editName}
                          maxLength={MAX_GUEST_NAME_LENGTH}
                          onChange={(event) => setEditName(event.target.value)}
                          data-testid={'group-edit-name-input-' + person.id}
                          aria-label={t('editName')}
                        />
                        <Button type="submit" className="min-h-11" disabled={!editName.trim() || rename.isPending}>
                          {t('saveName')}
                        </Button>
                        <Button type="button" variant="outline" className="min-h-11" onClick={() => setEditingId(null)}>
                          {t('cancelButton')}
                        </Button>
                      </form>
                    )}
                    {isCreator && editable && person.id !== group.representativeId && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-2 min-h-11 max-w-full whitespace-normal"
                        disabled={save.isPending}
                        onClick={() =>
                          writeGroups(
                            groups.map((entry) =>
                              entry.key === group.key
                                ? { representativeId: person.id, memberIds: entry.memberIds }
                                : entry,
                            ),
                            'group:' + group.key,
                          )
                        }
                        data-testid={'payment-group-leader-' + person.id}
                      >
                        {t('paymentGroupMakeResponsible', { name: person.name })}
                      </Button>
                    )}
                  </div>
                ))}
                {isCreator && editable && (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={save.isPending}
                    onClick={() =>
                      writeGroups(
                        groups.filter((entry) => entry.key !== group.key),
                        'all',
                      )
                    }
                    data-testid={'payment-group-remove-' + number}
                  >
                    {t('paymentGroupDissolve')}
                  </Button>
                )}
              </CardContent>
            </Card>
          </div>
        );
      })}
      {canCreate && (
        <div
          role="tabpanel"
          hidden={visibleTab !== 'create'}
          id="people-subpanel-create"
          aria-labelledby="people-subtab-create"
          className="min-w-0 space-y-3"
          data-testid="people-subpanel-create"
        >
          <Card>
            <CardContent className="space-y-3 py-4">
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
                className="min-h-11 w-full min-w-0 rounded-md border bg-background px-3 text-base"
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
              {candidates.map((person) => (
                <label
                  key={person.id}
                  className="flex min-h-11 min-w-0 items-center gap-3 rounded-md border px-3 py-2"
                  data-testid={'payment-group-member-' + person.id}
                >
                  <input
                    type="checkbox"
                    className="size-5 shrink-0"
                    checked={selected.includes(person.id)}
                    disabled={save.isPending}
                    onChange={(event) =>
                      setMemberIds((before) =>
                        event.target.checked ? [...before, person.id] : before.filter((id) => id !== person.id),
                      )
                    }
                  />
                  <span className="min-w-0 break-words text-sm">{person.name}</span>
                </label>
              ))}
              <Button
                type="button"
                className="min-h-11 w-full whitespace-normal"
                disabled={save.isPending || !actualLeader || !selected.length}
                onClick={() =>
                  writeGroups(
                    [...groups, { representativeId: actualLeader, memberIds: [actualLeader, ...selected] }],
                    'group:' + groupMemberKey([actualLeader, ...selected]),
                  )
                }
                data-testid="payment-group-create"
              >
                {t('paymentGroupCreate')}
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
