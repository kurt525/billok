'use client';

import { useEffect, useState } from 'react';
import { formatCents } from '@/lib/money';
import { Input } from '@/components/ui/input';
import { formatShareCount } from '@/lib/ru-plurals';

type Member = { id: string; name: string | null };
type ShareEntry = { userId: string; amount: number; shares: number };

export function SharesSplit({
  members,
  totalCents,
  onChange,
  locale,
  currency,
  initialShareUnits,
}: {
  members: Member[];
  totalCents: number;
  onChange: (shares: ShareEntry[]) => void;
  locale?: string;
  currency?: string;
  /** Initial share-unit strings per user ID (e.g. when editing an existing expense). */
  initialShareUnits?: Record<string, string>;
}) {
  const [shareUnits, setShareUnits] = useState<Record<string, string>>(
    () => initialShareUnits ?? Object.fromEntries(members.map((m) => [m.id, '1'])),
  );

  useEffect(() => {
    const entries = members
      .map((m) => ({
        userId: m.id,
        units: parseInt(shareUnits[m.id] ?? '0') || 0,
      }))
      .filter((e) => e.units > 0);

    const totalUnits = entries.reduce((sum, e) => sum + e.units, 0);
    if (totalUnits === 0 || totalCents <= 0) {
      onChange([]);
      return;
    }

    let allocated = 0;
    const shares: ShareEntry[] = entries.map((entry, i) => {
      let amount: number;
      if (i === entries.length - 1) {
        amount = totalCents - allocated;
      } else {
        amount = Math.round((totalCents * entry.units) / totalUnits);
        allocated += amount;
      }
      return { userId: entry.userId, amount, shares: entry.units };
    });

    onChange(shares);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareUnits, totalCents]);

  function setUnits(id: string, value: string) {
    setShareUnits((prev) => ({ ...prev, [id]: value }));
  }

  const totalUnits = members.reduce((sum, m) => sum + (parseInt(shareUnits[m.id] ?? '0') || 0), 0);

  return (
    <div className="space-y-2">
      {members.map((m) => {
        const units = parseInt(shareUnits[m.id] ?? '0') || 0;
        const share = totalUnits > 0 ? Math.round((totalCents * units) / totalUnits) : 0;
        return (
          <div
            key={m.id}
            className="flex min-w-0 flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center"
            data-testid="split-member-row"
          >
            <span className="min-w-0 flex-1 break-words text-sm">{m.name ?? 'Без имени'}</span>
            <Input
              type="number"
              inputMode="numeric"
              step="1"
              min="0"
              placeholder="1"
              className="h-11 w-20 min-w-0 text-base"
              value={shareUnits[m.id] ?? ''}
              onChange={(e) => setUnits(m.id, e.target.value)}
            />
            <span className="text-xs text-muted-foreground">долей</span>
            {units > 0 && totalCents > 0 && (
              <span className="max-w-full break-words text-right text-xs text-muted-foreground sm:ml-auto">
                {formatCents(share, currency, locale)}
              </span>
            )}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">Всего: {formatShareCount(totalUnits)}</p>
    </div>
  );
}
