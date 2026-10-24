/** Date and time display for the Russian-only BillOK interface. */
export function formatRussianDate(isoString: string, timeZone?: string): string {
  const value = new Date(isoString);
  return value.toLocaleDateString('ru-RU', timeZone ? { timeZone } : undefined);
}

export function formatRussianTime(isoString: string, timeZone?: string): string {
  const value = new Date(isoString);
  return value.toLocaleTimeString('ru-RU', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
}
