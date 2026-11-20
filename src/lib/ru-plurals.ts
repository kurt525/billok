/** Russian grammatical forms for the number of shares in a bill. */
export function formatShareCount(count: number): string {
  const form = new Intl.PluralRules('ru-RU').select(count);
  const noun = form === 'one' ? 'доля' : form === 'few' ? 'доли' : 'долей';
  return `${count} ${noun}`;
}
