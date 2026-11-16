// Service worker of the ERP site — phone notifications only (sql/244). It caches nothing and answers no page request,
// so the site always loads from the network exactly as before.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  const title = d.title || 'Approval request';
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || 'Open the Approval Center.',
    tag: d.tag || undefined,
    icon: '/icons/tatgold-emblem-192.png',
    badge: '/icons/tatgold-emblem-192.png',
    data: { url: d.url || '/approvals/' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/approvals/', self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin !== self.location.origin) continue;
      try { await c.focus(); if ('navigate' in c) await c.navigate(url); return; } catch (e) { /* open a window instead */ }
    }
    await self.clients.openWindow(url);
  })());
});
