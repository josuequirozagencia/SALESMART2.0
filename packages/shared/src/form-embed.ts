/**
 * Código del formulario embebible (M9.2, ADR-09/54): lo sirve la API como `/v1/embed/v1.js` y lo carga la página del cliente con una sola etiqueta
 * `<script src=".../v1/embed/v1.js" data-form="TOKEN" async></script>`. Vive aquí (texto plano, sin dependencias ni compilación) para que la API lo sirva y las pruebas
 * de la web lo ejecuten con el mismo texto.
 *
 * Diseño: una función autoejecutable en JavaScript clásico (sin `eval`, sin HTML construido con texto del servidor: todo se arma con `createElement` y `textContent`),
 * que dibuja el formulario dentro de un Shadow DOM (la hoja de estilos de la página no lo toca ni él toca la de la página), pide la definición pública del formulario,
 * valida lo mínimo, manda el envío con una llave de idempotencia estable entre reintentos y avisa a la página con el evento `salesmart:lead` (con el `event_id` que el
 * Pixel debe usar para deduplicar). El captcha (Turnstile) se dibuja en el documento y se proyecta con una ranura: no funciona bien dentro de un Shadow DOM.
 *
 * No uses comillas invertidas ni la secuencia dólar-llave en este texto: va dentro de una plantilla de cadena.
 */
export const FORM_EMBED_VERSION = 1;

export const FORM_EMBED_SCRIPT = String.raw`(function () {
  'use strict';
  var script = document.currentScript;
  if (!script) {
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) {
      if (all[i].getAttribute('data-form')) { script = all[i]; break; }
    }
  }
  if (!script) return;
  var token = script.getAttribute('data-form');
  if (!token) return;
  var base;
  try { base = new URL(script.src, location.href).origin; } catch (e) { return; }
  var targetSel = script.getAttribute('data-target');
  var host = targetSel ? document.querySelector(targetSel) : null;
  if (!host) {
    host = document.createElement('div');
    script.parentNode.insertBefore(host, script.nextSibling);
  }
  if (host.getAttribute('data-salesmart-form')) return;
  host.setAttribute('data-salesmart-form', token);
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  var inFrame = window.parent !== window;

  var CSS = ':host{display:block;font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1c1b29}' +
    '*{box-sizing:border-box}form{display:grid;gap:14px;max-width:520px}' +
    'label.f{display:grid;gap:6px;font-size:14px;font-weight:600}' +
    'input[type=text],input[type=email],input[type=tel],input[type=number],select,textarea{font:inherit;font-weight:400;padding:11px 12px;border:1px solid #c9c6dc;border-radius:10px;background:#fff;color:inherit;width:100%}' +
    'textarea{min-height:96px;resize:vertical}' +
    'input:focus,select:focus,textarea:focus,button:focus-visible{outline:2px solid #6a44f2;outline-offset:1px}' +
    '[aria-invalid=true]{border-color:#b3341f}' +
    '.err{color:#b3341f;font-size:13px;font-weight:500}' +
    '.req{color:#b3341f}' +
    '.consent{display:flex;gap:10px;align-items:flex-start;font-size:13px;font-weight:400}.consent input{margin-top:3px}' +
    'button{font:inherit;font-weight:700;padding:13px 18px;border:0;border-radius:10px;background:#6a44f2;color:#fff;cursor:pointer}' +
    'button[disabled]{opacity:.6;cursor:not-allowed}' +
    '.ok{padding:16px;border-radius:10px;background:#e6f6ec;color:#17623a;font-weight:600}' +
    '.bad{padding:12px;border-radius:10px;background:#fbe9e6;color:#8c2a18;font-size:14px}' +
    '.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}';
  try {
    if (typeof CSSStyleSheet === 'function' && root.adoptedStyleSheets !== undefined && CSSStyleSheet.prototype.replaceSync) {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } else { throw new Error('sin hojas construibles'); }
  } catch (e) {
    var st = document.createElement('style');
    st.textContent = CSS;
    root.appendChild(st);
  }

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function uuid() {
    var c = window.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b); else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = [];
    for (var j = 0; j < 16; j++) h.push((b[j] + 256).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' + h.slice(10).join('');
  }
  function cookie(name) {
    var parts = document.cookie ? document.cookie.split('; ') : [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].split('=');
      if (p[0] === name) return decodeURIComponent(p.slice(1).join('='));
    }
    return null;
  }
  // Dentro de un iframe, la página que importa es la que lo incrusta (si el navegador la informa): de ahí salen los parámetros de campaña y la página de origen
  function pageUrl() { return inFrame && document.referrer ? document.referrer : location.href; }
  function tracking() {
    var out = { utm: {}, fbc: null, fbp: cookie('_fbp') };
    try {
      var q = new URL(pageUrl()).searchParams;
      q.forEach(function (v, k) {
        var key = k.toLowerCase();
        if (/^(utm_[a-z0-9_]+|fbclid|gclid)$/.test(key)) out.utm[key] = String(v).slice(0, 200);
      });
      out.fbc = cookie('_fbc');
      if (!out.fbc && out.utm.fbclid) out.fbc = 'fb.1.' + Date.now() + '.' + out.utm.fbclid;
    } catch (e) { /* sin parámetros */ }
    return out;
  }

  function show(msg) {
    var box = el('div', { class: 'bad', role: 'status' }, msg);
    root.appendChild(box);
  }

  fetch(base + '/v1/public/forms/' + encodeURIComponent(token), { credentials: 'omit', mode: 'cors' }).then(function (r) {
    return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
  }).then(function (res) {
    if (!res.ok) { show(res.status === 403 ? 'Este formulario no está autorizado para este sitio.' : 'El formulario no está disponible por ahora.'); return; }
    render(res.body);
  }).catch(function () { show('No pudimos cargar el formulario. Revisa tu conexión e inténtalo de nuevo.'); });

  function render(def) {
    var form = el('form', { novalidate: 'novalidate', 'aria-label': def.name || 'Formulario' });
    var inputs = {};
    var errors = {};
    (def.fields || []).forEach(function (f) {
      var wrap = el('label', { class: 'f' });
      var label = el('span', null, f.label);
      if (f.required) { var star = el('span', { class: 'req', 'aria-hidden': 'true' }, ' *'); label.appendChild(star); }
      wrap.appendChild(label);
      var input;
      if (f.kind === 'long_text') input = el('textarea', { name: f.key, rows: '4' });
      else if (f.kind === 'select') {
        input = el('select', { name: f.key });
        input.appendChild(el('option', { value: '' }, 'Elige una opción'));
        (f.options || []).forEach(function (o) { input.appendChild(el('option', { value: o }, o)); });
      } else {
        var type = f.kind === 'email' ? 'email' : f.kind === 'phone' ? 'tel' : f.kind === 'number' ? 'number' : 'text';
        input = el('input', { type: type, name: f.key });
        if (f.kind === 'phone') input.setAttribute('inputmode', 'tel');
        if (f.kind === 'number') input.setAttribute('step', 'any');
      }
      input.setAttribute('autocomplete', f.kind === 'email' ? 'email' : f.kind === 'phone' ? 'tel' : 'on');
      if (f.placeholder) input.setAttribute('placeholder', f.placeholder);
      if (f.required) input.setAttribute('aria-required', 'true');
      var err = el('span', { class: 'err', role: 'alert' });
      err.hidden = true;
      wrap.appendChild(input);
      wrap.appendChild(err);
      form.appendChild(wrap);
      inputs[f.key] = input;
      errors[f.key] = err;
    });

    var hpWrap = el('div', { class: 'hp', 'aria-hidden': 'true' });
    var hp = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off' });
    hpWrap.appendChild(hp);
    form.appendChild(hpWrap);

    var consent = el('label', { class: 'consent' });
    var box = el('input', { type: 'checkbox', name: 'consent' });
    consent.appendChild(box);
    consent.appendChild(el('span', null, def.consent_text || ''));
    form.appendChild(consent);
    var consentErr = el('span', { class: 'err', role: 'alert' });
    consentErr.hidden = true;
    form.appendChild(consentErr);

    var captchaToken = null;
    var provider = def.captcha && def.captcha.provider;
    var widgetId = null;
    if (provider === 'fake') captchaToken = 'fake-pass';
    else if (provider === 'turnstile' && def.captcha.site_key) {
      var slot = el('slot', { name: 'captcha' });
      form.appendChild(slot);
      var holder = el('div', { slot: 'captcha' });
      host.appendChild(holder);
      loadTurnstile(function () {
        if (!window.turnstile) return;
        widgetId = window.turnstile.render(holder, {
          sitekey: def.captcha.site_key,
          callback: function (t) { captchaToken = t; },
          'expired-callback': function () { captchaToken = null; },
          'error-callback': function () { captchaToken = null; }
        });
      });
    }

    var general = el('div', { class: 'bad', role: 'alert' });
    general.hidden = true;
    form.appendChild(general);
    var submit = el('button', { type: 'submit' }, 'Enviar');
    form.appendChild(submit);
    root.appendChild(form);

    // La llave de idempotencia y el identificador del evento duran lo que dura UN envío (incluidos sus reintentos)
    var attempt = null;
    function fail(key, msg) {
      var e = errors[key];
      if (e) { e.textContent = msg; e.hidden = false; inputs[key].setAttribute('aria-invalid', 'true'); }
    }
    function clear() {
      Object.keys(errors).forEach(function (k) { errors[k].hidden = true; errors[k].textContent = ''; inputs[k].removeAttribute('aria-invalid'); });
      consentErr.hidden = true;
      general.hidden = true;
    }
    function say(msg) { general.textContent = msg; general.hidden = false; }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (submit.disabled) return;
      clear();
      var bad = false;
      var values = {};
      (def.fields || []).forEach(function (f) {
        var v = inputs[f.key].value.trim();
        if (v === '' && f.required) { fail(f.key, f.label + ' es obligatorio'); bad = true; }
        else if (v !== '') values[f.key] = v;
      });
      if (!box.checked) { consentErr.textContent = 'Debes aceptar el consentimiento para enviar el formulario'; consentErr.hidden = false; bad = true; }
      if (provider === 'turnstile' && !captchaToken) { say('Completa la verificación para continuar.'); bad = true; }
      if (bad) return;
      if (!attempt) attempt = { key: uuid(), eventId: uuid() };
      var t = tracking();
      var body = { values: values, consent: true, hp: hp.value, event_id: attempt.eventId, source_url: pageUrl() };
      if (captchaToken) body.captcha_token = captchaToken;
      if (Object.keys(t.utm).length) body.utm = t.utm;
      if (t.fbc) body.fbc = t.fbc;
      if (t.fbp) body.fbp = t.fbp;
      submit.disabled = true;
      fetch(base + '/v1/public/forms/' + encodeURIComponent(token) + '/submit', {
        method: 'POST', mode: 'cors', credentials: 'omit',
        headers: { 'content-type': 'application/json', 'idempotency-key': attempt.key },
        body: JSON.stringify(body)
      }).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
      }).then(function (res) {
        if (res.ok && res.body && res.body.ok) { done(res.body); return; }
        submit.disabled = false;
        var err = res.body && res.body.error;
        if (res.status === 400 && err && err.details && err.details.length) {
          var shown = false;
          err.details.forEach(function (d) {
            var key = String(d.path || '').replace(/^values\./, '');
            if (errors[key]) { fail(key, d.message); shown = true; }
            else if (d.path === 'consent') { consentErr.textContent = d.message; consentErr.hidden = false; shown = true; }
          });
          if (!shown) say('Revisa los datos e inténtalo de nuevo.');
          attempt = null;
        } else if (err && err.code === 'CAPTCHA_FAILED') {
          say('No pudimos comprobar que eres una persona. Inténtalo de nuevo.');
          captchaToken = null;
          if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
          attempt = null;
        } else if (res.status === 403) say('Este formulario no está autorizado para este sitio.');
        else if (res.status === 404) say('El formulario no está disponible por ahora.');
        else if (res.status === 429) say('Demasiados intentos. Inténtalo de nuevo en un momento.');
        else say('No pudimos enviar el formulario. Inténtalo de nuevo.');
      }).catch(function () {
        submit.disabled = false;
        say('No pudimos enviar. Revisa tu conexión e inténtalo de nuevo.');
      });
    });

    function done(res) {
      var detail = { event_id: res.event_id, form: token };
      try { window.dispatchEvent(new CustomEvent('salesmart:lead', { detail: detail })); } catch (e) { /* sin CustomEvent */ }
      if (inFrame) { try { window.parent.postMessage({ type: 'salesmart:lead', form: token, event_id: res.event_id }, '*'); } catch (e) { /* sin padre */ } }
      var dest = res.redirect_url;
      if (typeof dest === 'string' && dest.indexOf('https://') === 0) { window.location.assign(dest); return; }
      if (form.parentNode) form.parentNode.removeChild(form);
      var held = host.querySelectorAll('[slot=captcha]');
      for (var i = 0; i < held.length; i++) held[i].parentNode.removeChild(held[i]);
      root.appendChild(el('div', { class: 'ok', role: 'status' }, res.message || 'Gracias, recibimos tus datos.'));
    }
  }

  function loadTurnstile(cb) {
    if (window.turnstile) { cb(); return; }
    var id = 'salesmart-turnstile';
    var existing = document.getElementById(id);
    if (existing) { existing.addEventListener('load', cb); return; }
    var s = document.createElement('script');
    s.id = id;
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = cb;
    document.head.appendChild(s);
  }
})();
`;
