import { UserRound, UserRoundCheck } from 'lucide-react';

type GuestAccountStatusProps = {
  isRegistered: boolean;
  registeredLabel: string;
  guestLabel: string;
};

/** Visual participant type from the SERVER, unrelated to receipt roles. */
export function GuestAccountStatus({ isRegistered, registeredLabel, guestLabel }: GuestAccountStatusProps) {
  return (
    <span
      className={
        'inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ' +
        (isRegistered
          ? 'border-slate-500 bg-white text-slate-950 shadow-sm dark:border-slate-200 dark:bg-slate-950 dark:text-white'
          : 'border-dashed border-slate-500 bg-white text-slate-900 dark:border-slate-400 dark:bg-slate-950 dark:text-white')
      }
      data-testid={isRegistered ? 'account-status-registered' : 'account-status-guest'}
    >
      {isRegistered ? (
        <UserRoundCheck aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <UserRound aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      <span>{isRegistered ? registeredLabel : guestLabel}</span>
    </span>
  );
}
