import Image from 'next/image';
import type { SbpBank } from '@/lib/sbp-banks';

/**
 * Bank icons are served from BillOK's own public/banks directory. If the
 * registry source has no reusable logo, explicitly show a textual fallback;
 * never manufacture a brand mark or load remote hotlinked images.
 */
export function SbpBankLogo({
  bank,
  unavailableLabel,
}: {
  bank: Pick<SbpBank, 'id' | 'name' | 'icon'>;
  unavailableLabel: string;
}) {
  if (bank.icon) {
    return (
      <Image
        src={bank.icon}
        width={40}
        height={40}
        alt=""
        unoptimized
        className="size-10 shrink-0 rounded-md object-contain"
        aria-hidden="true"
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={unavailableLabel}
      title={unavailableLabel}
      data-testid={'sbp-bank-fallback-' + bank.id}
      className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted px-1 text-center text-xs font-semibold"
    >
      {bank.name.trim().slice(0, 2).toLocaleUpperCase('ru-RU')}
    </span>
  );
}
