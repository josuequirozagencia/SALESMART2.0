/* Service worker de Sales Smart: SOLO notificaciones push (v6 fase E, ADR-64). No guarda nada en caché ni intercepta peticiones.
   Archivo propio y no un script en línea: la política de contenido solo permite scripts del mismo origen.
   v11 §3: las notificaciones llevan el icono y el badge de la marca de la plataforma (`GET /v1/branding`, público y del mismo origen). Antes no pasaban `icon` ni `badge`, y por eso
   cada sistema mostraba su icono genérico. Si la marca no se puede leer se usan las direcciones sin versión, que el servidor responde siempre (icono propio o el de por omisión). */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

var BRAND_URL = '/v1/branding';
var FALLBACK_ICON = '/v1/branding/icon-192.png';
var FALLBACK_BADGE = '/v1/branding/badge-96.png';
var BRAND_TTL_MS = 5 * 60 * 1000;
var brandCache = null;

/** El icono, el badge y el nombre vigentes (con memoria de 5 minutos). Nunca falla: sin respuesta válida devuelve las direcciones de respaldo. */
function brandInfo() {
  var now = Date.now();
  if (brandCache && now - brandCache.at < BRAND_TTL_MS) return Promise.resolve(brandCache.value);
  var fallback = { icon: FALLBACK_ICON, badge: FALLBACK_BADGE, name: 'Sales Smart' };
  return fetch(BRAND_URL, { credentials: 'omit' })
    .then(function (r) {
      return r.ok ? r.json() : null;
    })
    .then(function (b) {
      var own = function (u, alt) {
        // Solo direcciones de esta misma aplicación bajo /v1/branding/
        return typeof u === 'string' && u.indexOf('/v1/branding/') === 0 ? u : alt;
      };
      var value = b && b.icon ? { icon: own(b.icon.icon_192, FALLBACK_ICON), badge: own(b.icon.badge_96, FALLBACK_BADGE), name: typeof b.name === 'string' && b.name ? b.name : fallback.name } : fallback;
      brandCache = { at: Date.now(), value: value };
      return value;
    })
    .catch(function () {
      return fallback;
    });
}

self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  event.waitUntil(
    // v13 S4.1: AQUÍ no se decide si mostrar el aviso. Quién está mirando qué conversación lo sabe el servidor (presencia por persona con latido); si el mensaje es de la conversación que la persona
    // tiene abierta y a la vista, el servidor ni siquiera manda el push. Antes se ocultaba con CUALQUIER ventana a la vista, y quien miraba otra conversación nunca se enteraba. Cada mensaje lleva
    // su propia `tag`: los avisos de una misma conversación no se reemplazan entre sí.
    brandInfo().then(function (brand) {
      return self.registration.showNotification(typeof data.title === 'string' && data.title ? data.title : brand.name, {
        body: typeof data.body === 'string' && data.body ? data.body : 'Mensaje nuevo',
        icon: brand.icon,
        badge: brand.badge,
        tag: typeof data.tag === 'string' ? data.tag : undefined,
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
