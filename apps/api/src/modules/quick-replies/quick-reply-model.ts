import type { CustomValue } from '../custom-fields';

/**
 * Variables de las respuestas rápidas (M5.6b, ADR-50). Dominio PURO: sin base de datos ni reloj.
 *
 * Una variable se escribe `{{nombre}}`. Las de la casa son fijas y en español, para que quien escribe la respuesta no tenga que aprender nada:
 *   `{{primer_nombre}}` · `{{nombre}}` · `{{telefono}}` (del contacto de la conversación) · `{{mi_nombre}}` (quien escribe) · `{{empresa}}` (el negocio).
 * Los campos personalizados del contacto (ADR-44) se escriben `{{contact.<variable>}}` con la variable que ya tienen. Lo que no se puede resolver (el contacto no
 * tiene ese dato, o el campo se archivó) NO se borra ni se inventa: queda como `{{…}}` y se avisa, para que la persona lo complete antes de enviar.
 */

export const BUILT_IN_VARIABLES = ['primer_nombre', 'nombre', 'telefono', 'mi_nombre', 'empresa'] as const;
export type BuiltInVariable = (typeof BUILT_IN_VARIABLES)[number];

/** Cómo se muestra cada variable de la casa en la pantalla de configuración. */
export const BUILT_IN_LABELS: Readonly<Record<BuiltInVariable, string>> = {
  primer_nombre: 'Primer nombre del contacto',
  nombre: 'Nombre completo del contacto',
  telefono: 'Teléfono del contacto',
  mi_nombre: 'Mi nombre (quien escribe)',
  empresa: 'Nombre de la empresa',
};

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;
const CUSTOM = /^contact\.([a-z][a-z0-9_]{0,39})$/;
const isBuiltIn = (v: string): v is BuiltInVariable => (BUILT_IN_VARIABLES as readonly string[]).includes(v);

/** Las variables que usa un texto, sin repetir, en el orden en que aparecen y en minúsculas. */
export function variablesIn(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(PLACEHOLDER)) seen.add(m[1]!.toLowerCase());
  return [...seen];
}

/** Variables que no son de la casa ni un campo personalizado vigente. `activeCustom` = variables de los campos personalizados del contacto que no están archivados. */
export function unknownVariables(body: string, activeCustom: ReadonlySet<string>): string[] {
  return variablesIn(body).filter((v) => {
    if (isBuiltIn(v)) return false;
    const c = CUSTOM.exec(v);
    return !(c && activeCustom.has(c[1]!));
  });
}

/** Datos para resolver las variables en una conversación concreta. */
export interface ResolveContext {
  contactName: string;
  contactPhone: string | null;
  agentName: string;
  orgName: string;
  /** Valores no vacíos de campos personalizados NO archivados, por variable. */
  custom: Readonly<Record<string, CustomValue>>;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Un valor de campo personalizado como texto para el cliente. */
export function formatCustom(v: CustomValue): string {
  if (typeof v === 'boolean') return v ? 'Sí' : 'No';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'number') return String(v);
  const d = DATE_ONLY.exec(v);
  return d ? `${d[3]}/${d[2]}/${d[1]}` : v;
}

function valueOf(variable: string, ctx: ResolveContext): string | null {
  const clean = (s: string | null | undefined): string | null => {
    const t = (s ?? '').trim();
    return t === '' ? null : t;
  };
  if (isBuiltIn(variable)) {
    switch (variable) {
      case 'primer_nombre':
        return clean(ctx.contactName.trim().split(/\s+/)[0]);
      case 'nombre':
        return clean(ctx.contactName);
      case 'telefono':
        return clean(ctx.contactPhone);
      case 'mi_nombre':
        return clean(ctx.agentName);
      case 'empresa':
        return clean(ctx.orgName);
    }
  }
  const c = CUSTOM.exec(variable);
  const raw = c ? ctx.custom[c[1]!] : undefined;
  return raw === undefined ? null : clean(formatCustom(raw));
}

export interface Resolved {
  /** El texto con lo que se pudo resolver; lo demás queda como `{{variable}}`. */
  text: string;
  /** Variables que no se pudieron resolver (sin repetir). */
  missing: string[];
}

/** Resuelve en UNA pasada: un valor que contenga `{{…}}` no se vuelve a interpretar. */
export function resolve(body: string, ctx: ResolveContext): Resolved {
  const missing = new Set<string>();
  const text = body.replace(PLACEHOLDER, (whole, name: string) => {
    const key = name.toLowerCase();
    const v = valueOf(key, ctx);
    if (v === null) {
      missing.add(key);
      return whole;
    }
    return v;
  });
  return { text, missing: [...missing] };
}

/** Las variables de campos personalizados que usa un texto (sin el prefijo), para leer solo esos valores del contacto. */
export function customKeysIn(body: string): string[] {
  return variablesIn(body).flatMap((v) => {
    const c = CUSTOM.exec(v);
    return c ? [c[1]!] : [];
  });
}
