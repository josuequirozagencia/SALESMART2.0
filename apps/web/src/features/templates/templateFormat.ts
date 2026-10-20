import type { Template, TemplateVariable } from '../../lib/types';
import type { PillKind } from '../../ui/Pill';

export const CATEGORY_LABEL: Record<string, string> = { marketing: 'Marketing', utility: 'Utilidad', authentication: 'Autenticación', other: 'Otra' };
export const CATEGORY_KIND: Record<string, PillKind> = { marketing: 'warn', utility: 'info', authentication: 'muted', other: 'muted' };
export const STATUS_LABEL: Record<string, string> = { approved: 'Aprobada', pending: 'En revisión', rejected: 'Rechazada', paused: 'En pausa', disabled: 'Deshabilitada', other: 'Sin aprobar' };
export const STATUS_KIND: Record<string, PillKind> = { approved: 'ok', pending: 'warn', rejected: 'crit', paused: 'warn', disabled: 'crit', other: 'muted' };

/** Cómo se llama una variable en el formulario: «Variable 1», «Variable nombre», «Encabezado», «Botón de enlace». */
export function variableLabel(v: TemplateVariable): string {
  if (v.part === 'header') return 'Encabezado';
  if (v.part === 'button') return 'Botón de enlace';
  return `Variable ${v.key}`;
}

/** Reemplaza `{{clave}}` por su valor; lo que aún no tiene valor queda como está. */
export function fillTemplate(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, key: string) => (values[key] && values[key]!.trim() !== '' ? values[key]!.trim() : whole));
}

/** Los valores de una parte (encabezado, cuerpo o un botón) tal como los llena el formulario, por clave de variable. */
export function valuesOf(vars: readonly TemplateVariable[], params: Readonly<Record<string, string>>, part: TemplateVariable['part'], buttonIndex: number | null = null): Record<string, string> {
  return Object.fromEntries(vars.filter((v) => v.part === part && v.buttonIndex === buttonIndex).map((v) => [v.key, params[v.id] ?? '']));
}

/** Largo máximo de cada variable (las reglas de Meta; el servidor las vuelve a exigir). */
export const MAX_VALUE: Record<TemplateVariable['part'], number> = { header: 60, body: 1024, button: 500 };

export const hasVariables = (t: Template): boolean => t.variables.length > 0;
