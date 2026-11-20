/**
 * Fail-closed gate for synthetic BillOK fixtures.
 * The opt-in flag alone is never enough: the database must also be the
 * disposable loopback-only PostgreSQL instance created by mobile CI.
 */
export function assertDisposableQaDatabase(env: Record<string, string | undefined>): string {
  if (env.BILLOK_QA_FIXTURES !== '1') {
    throw new Error('Synthetic BillOK data requires explicit QA fixture opt-in');
  }

  let url: URL;
  try {
    url = new URL(env.DATABASE_URL ?? '');
  } catch {
    throw new Error('Synthetic BillOK data requires a disposable local PostgreSQL database');
  }

  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.pathname !== '/billokqa' ||
    url.username !== 'billokqa' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Refusing to seed a database other than disposable loopback billokqa');
  }

  return url.toString();
}
