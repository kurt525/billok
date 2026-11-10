/* BillOK Web Push worker: no app-shell caching, token storage or fetch interception. */
self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let message = {};
      try {
        message = event.data ? event.data.json() : {};
      } catch {
        // A broken payload never exposes private data or prevents the fallback inbox.
      }
      const path = typeof message.url === 'string' && /^\/split\/[A-Za-z0-9_-]+\/claim$/.test(message.url)
        ? message.url
        : '/';
      await self.registration.showNotification('BillOK', {
        body: 'Поступление перевода подтверждено. Откройте чек в BillOK.',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: typeof message.tag === 'string' && /^billok-receipt-[0-9a-f-]{36}$/.test(message.tag)
          ? message.tag
          : 'billok-receipt',
        data: { url: path },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const requested = event.notification.data?.url;
      const path = typeof requested === 'string' && /^\/split\/[A-Za-z0-9_-]+\/claim$/.test(requested)
        ? requested
        : '/';
      const target = new URL(path, self.location.origin).href;
      const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((client) => client.url === target);
      if (existing) return existing.focus();
      return clients.openWindow(target);
    })(),
  );
});
