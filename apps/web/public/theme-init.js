/* Aplica el tema elegido (claro u oscuro) ANTES del primer pintado, para que no haya parpadeo. Archivo propio y no un script en línea:
   la política de contenido solo permite scripts del mismo origen. Sin elección guardada ("sistema") no hace nada: manda prefers-color-scheme. */
(function () {
  try {
    var m = window.localStorage.getItem('ss.theme.v1');
    if (m === 'light' || m === 'dark') document.documentElement.setAttribute('data-theme', m);
    var b = window.localStorage.getItem('ss.brand.v1');
    if (b === 'green' || b === 'red' || b === 'whatsapp') document.documentElement.setAttribute('data-brand', b);
  } catch (e) {
    /* sin almacenamiento: se usa el tema del sistema */
  }
})();
