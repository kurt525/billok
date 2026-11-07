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
          ? 'border-sky-500/40 bg-sky-500/10 text-foreground'
          : 'border-dashed border-muted-foreground/40 bg-muted/60 text-muted-foreground')
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
