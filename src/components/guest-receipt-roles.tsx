type GuestReceiptRolesProps = {
  isCreator: boolean;
  isPayer: boolean;
  creatorLabel: string;
  payerLabel: string;
};

/** Emoji and visible text deliberately accompany one another for accessibility. */
export function GuestReceiptRoles({ isCreator, isPayer, creatorLabel, payerLabel }: GuestReceiptRolesProps) {
  if (!isCreator && !isPayer) return null;
  return (
    <span
      className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1 align-middle"
      data-testid="receipt-roles"
    >
      {isCreator && (
        <span
          className="inline-flex min-w-0 items-center gap-1 rounded-md border bg-background/80 px-1.5 py-0.5 text-[11px] font-medium text-foreground"
          data-testid="receipt-role-creator"
        >
          <span aria-hidden="true">👑</span>
          <span>{creatorLabel}</span>
        </span>
      )}
      {isPayer && (
        <span
          className="inline-flex min-w-0 items-center gap-1 rounded-md border bg-background/80 px-1.5 py-0.5 text-[11px] font-medium text-foreground"
          data-testid="receipt-role-payer"
        >
          <span aria-hidden="true">💵</span>
          <span>{payerLabel}</span>
        </span>
      )}
    </span>
  );
}
