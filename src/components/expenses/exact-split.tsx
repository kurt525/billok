'use client';

import { useEffect, useState } from 'react';
import { formatCents, parseToCents } from '@/lib/money';
import { Input } from '@/components/ui/input';

type Member = { id: string; name: string | null };
type ShareEntry = { userId: string; amount: number };

export function ExactSplit({
  members,
  totalCents,
  onChange,
  locale,
  currency,
  initialAmounts,
}: {
  members: Member[];
  totalCents: number;
  onChange: (shares: ShareEntry[]) => void;
  locale?: string;
  currency?: string;
  /** Initial decimal amount strings per user ID (e.g. when editing an existing expense). */
  initialAmounts?: Record<string, string>;
}) {
  const [amounts, setAmounts] = useState<Record<string, string>>(() => initialAmounts ?? {});

  useEffect(() => {
    const shares: ShareEntry[] = [];
    for (const m of members) {
      const cents = parseToCents(amounts[m.id] ?? '0');
      if (cents > 0) {
        shares.push({ userId: m.id, amount: cents });
      }
    }
    onChange(shares);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amounts]);

  function setAmount(id: string, value: string) {
    setAmounts((prev) => ({ ...prev, [id]: value }));
  }

  const allocated = members.reduce((sum, m) => sum + parseToCents(amounts[m.id] ?? '0'), 0);
  const remaining = totalCents - allocated;

  return (
    <div className="space-y-2">
      {members.map((m) => (
        <div key={m.id} className="flex items-center gap-3 rounded-md border p-3">
          <span className="min-w-0 flex-1 break-words text-sm">{m.name ?? 'Без имени'}</span>
          <Input
            type="text"
            inputMode="decimal"
            placeholder="0,00"
            className="w-28"
            value={amounts[m.id] ?? ''}
            onChange={(e) => setAmount(m.id, e.target.value)}
          />
        </div>
      ))}
      <p
        className={`text-xs ${
          remaining === 0 ? 'text-green-600' : remaining > 0 ? 'text-amber-600' : 'text-destructive'
        }`}
      >
        {remaining === 0
          ? 'Сумма распределена полностью'
          : remaining > 0
            ? `Осталось распределить: ${formatCents(remaining, currency, locale)}`
            : `Превышение суммы: ${formatCents(-remaining, currency, locale)}`}
      </p>
    </div>
  );
}
