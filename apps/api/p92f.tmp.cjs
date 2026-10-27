const fs = require('fs');
function ed(f, pairs) {
  let t = fs.readFileSync(f, 'utf8');
  const crlf = t.includes('\r\n');
  t = t.replace(/\r\n/g, '\n');
  for (const [a, b, all] of pairs) {
    if (!t.includes(a)) throw new Error(f + ' ancla ' + a.slice(0, 70));
    t = all ? t.split(a).join(b) : t.replace(a, () => b);
  }
  if (crlf) t = t.replace(/\n/g, '\r\n');
  fs.writeFileSync(f, t);
}
ed('src/modules/forms/forms.dto.ts', [
  [
    "follow_up_params: z.record(z.string().regex(/^[A-Za-z0-9_]{1,30}$/), z.string().max(200)),",
    "/** Valores de las variables de la plantilla, por su clave (`body:1`, `body:nombre`, `header:1`, `button:0:1`). */\n    follow_up_params: z.record(z.string().regex(/^(?:(?:header|body):[A-Za-z0-9_]{1,30}|button:\\d{1,2}:[A-Za-z0-9_]{1,30})$/), z.string().max(200)),",
  ],
]);
ed('test/forms/forms.test.ts', [
  ["    console.log(\"DBG\", await ok.clone().text());\n", ''],
  ["follow_up_params: { nombre: '{{primer_nombre}}' } })).status).toBe(400); // falta «servicio»", "follow_up_params: { 'body:nombre': '{{primer_nombre}}' } })).status).toBe(400); // falta «servicio»"],
  ["follow_up_params: { '1': 'x' } })).status).toBe(400); // pendiente de aprobación", "follow_up_params: { 'body:1': 'x' } })).status).toBe(400); // pendiente de aprobación"],
  ["follow_up_params: { nombre: '{{primer_nombre}}', servicio: 'cursos de {{formulario}}' } });", "follow_up_params: { 'body:nombre': '{{primer_nombre}}', 'body:servicio': 'cursos de {{formulario}}' } });"],
  ["params: { nombre: '{{primer_nombre}}', servicio: 'cursos de {{formulario}}' } });", "params: { 'body:nombre': '{{primer_nombre}}', 'body:servicio': 'cursos de {{formulario}}' } });"],
  ["params: Record<string, string> = { nombre: '{{primer_nombre}}', servicio: '{{formulario}}' })", "params: Record<string, string> = { 'body:nombre': '{{primer_nombre}}', 'body:servicio': '{{formulario}}' })"],
  ["follow_up_params: { 'con espacio': 'x' } })).status).toBe(400);", "follow_up_params: { 'con espacio': 'x', nombre: 'y' } })).status).toBe(400);"],
]);
console.log('ok');
