/* Notificaciones push de SMI Asistencia.
 * Se importa dentro del service worker de la PWA (workbox.importScripts en vite.config.ts), así que
 * se ejecuta aunque la app esté cerrada y la pantalla del celular apagada. */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'SMI Asistencia';
  const options = {
    body: data.body || '',
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag: data.tag || 'smi-alerta',
    renotify: true, // vuelve a sonar/vibrar aunque ya hubiera una alerta anterior
    requireInteraction: true, // se queda en pantalla hasta que el trabajador la toque
    vibrate: [300, 150, 300, 150, 600],
    timestamp: Date.now(),
    data: { url: data.url || '/', alertaId: data.alertaId || null },
  };

  event.waitUntil(
    (async () => {
      const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

      // Si la app está abierta y visible, se le avisa dentro de la app (banner) en lugar de una notificación del sistema
      const visible = ventanas.find((c) => c.visibilityState === 'visible');
      if (visible) {
        ventanas.forEach((c) =>
          c.postMessage({ type: 'alerta', id: data.alertaId || null, mensaje: data.body || '', titulo: title })
        );
        return;
      }
      await self.registration.showNotification(title, options);
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destino = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    (async () => {
      const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of ventanas) {
        if ('focus' in c) {
          await c.focus();
          c.postMessage({ type: 'alerta-abierta', id: (event.notification.data && event.notification.data.alertaId) || null });
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(destino);
    })()
  );
});
