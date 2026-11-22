// A receipt link expires at one server-defined instant, regardless of
// the browser's time zone. BillOK displays it in Moscow civil time.
const expiryFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  dateStyle: 'long',
  timeStyle: 'medium',
  hourCycle: 'h23',
});

export function formatReceiptLinkExpiry(expiresAt: Date | string): string {
  return expiryFormatter.format(new Date(expiresAt));
}
