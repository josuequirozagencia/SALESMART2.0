/**
 * La página alojada de un formulario (M9.2, ADR-09/54): el «enlace directo» y lo que carga el iframe. Es una página mínima de nuestra propia aplicación que carga el MISMO `embed.js` que usaría
 * la página del cliente, así que hay un solo código que mantener. Se sirve con una política de contenido propia: solo nuestro origen y Turnstile pueden cargar scripts, solo nuestro origen recibe
 * el envío, y **solo los dominios autorizados del formulario (y nuestra propia aplicación, para la vista previa) pueden incrustarla en un iframe** (`frame-ancestors`).
 */
const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Fuentes de `frame-ancestors` para los dominios autorizados (`mi-sitio.com`, `*.mi-sitio.com`, `localhost`). Nunca `*`. */
export function frameAncestors(domains: readonly string[]): string[] {
  const out = new Set<string>(["'self'"]);
  for (const d of domains) {
    if (!/^(\*\.)?[a-z0-9.-]+$/.test(d)) continue; // ya vienen normalizados: esto es defensa en profundidad contra inyectar otra directiva
    out.add(`https://${d}`);
    if (d === 'localhost') out.add('http://localhost:*');
  }
  return [...out];
}

export function formPageCsp(domains: readonly string[]): string {
  return [
    "default-src 'none'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    'frame-src https://challenges.cloudflare.com',
    'img-src data:',
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors(domains).join(' ')}`,
  ].join('; ');
}

export function formPageHtml(form: { name: string; token: string }): string {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(form.name)}</title>
<style>html,body{margin:0;background:#fff}body{padding:16px}</style></head>
<body><div id="form"></div><script src="/v1/embed/v1.js" data-form="${escapeHtml(form.token)}" data-target="#form"></script></body></html>
`;
}
