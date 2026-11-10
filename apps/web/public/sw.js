/* Service worker de Sales Smart: SOLO notificaciones push (v6 fase E, ADR-64). No guarda nada en caché ni intercepta peticiones.
   Archivo propio y no un script en línea: la política de contenido solo permite scripts del mismo origen. */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (wins) {
      // Con la aplicación a la vista ya suena y se ve en la bandeja: no se repite como notificación del sistema (salvo la de prueba, que lleva `force`)
      if (data.force !== true) {
        for (var i = 0; i < wins.length; i++) {
          if (wins[i].visibilityState === 'visible' && wins[i].focused) return undefined;
        }
      }
      return self.registration.showNotification(typeof data.title === 'string' && data.title ? data.title : 'Sales Smart', {
        body: typeof data.body === 'string' && data.body ? data.body : 'Mensaje nuevo',
        tag: typeof data.tag === 'string' ? data.tag : undefined,
        renotify: true,
        data: { url: typeof data.url === 'string' ? data.url : '/inbox' },
      });
    }),
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = '/inbox';
  try {
    // Solo direcciones de esta misma aplicación: nada que lleve a otro sitio
    var u = new URL((event.notification.data && event.notification.data.url) || '/inbox', self.location.origin);
    if (u.origin === self.location.origin) target = u.pathname + u.search;
  } catch (e) {
    target = '/inbox';
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (wins) {
      for (var i = 0; i < wins.length; i++) {
        if ('focus' in wins[i]) {
          if ('navigate' in wins[i]) return wins[i].navigate(target).then(function (c) { return c && c.focus(); });
          return wins[i].focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
