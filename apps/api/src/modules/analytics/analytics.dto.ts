import { z } from 'zod';

/** Máximo de días que abarca una consulta (un año y un día). */
export const MAX_RANGE_DAYS = 366;
/** Filas máximas de un reporte en pantalla o en CSV: más allá se avisa que el resultado está recortado. */
export const MAX_REPORT_ROWS = 5000;
export const REPORTS = ['sales', 'appointments', 'funnel', 'advisors', 'winning_ads'] as const;
export type ReportName = (typeof REPORTS)[number];

const instant = z.iso.datetime({ offset: true });

/**
 * «Anuncio ganador» (M6.6, ADR-55): `cohort` (por omisión) cuenta los contactos que LLEGARON en el periodo y cuántos de ellos ya compraron; `conversion` cuenta las citas y ventas que
 * OCURRIERON en el periodo, sin importar cuándo llegó el contacto. Los demás reportes lo ignoran.
 */
export const WINNING_MODES = ['cohort', 'conversion'] as const;
export type WinningMode = (typeof WINNING_MODES)[number];

/** Periodo: por omisión los últimos 30 días hasta ahora. `to` es exclusivo. */
export const rangeQuerySchema = z.object({ from: instant.optional(), to: instant.optional(), mode: z.enum(WINNING_MODES).optional() }).strict();
export type RangeQuery = z.infer<typeof rangeQuerySchema>;

export const exportSchema = z.object({ report: z.enum(REPORTS), from: instant.optional(), to: instant.optional(), mode: z.enum(WINNING_MODES).optional() }).strict();
export type ExportDto = z.infer<typeof exportSchema>;

/** Interruptor de la descarga para el asesor. */
export const settingsSchema = z.object({ advisor_export: z.boolean() }).strict();
export type SettingsDto = z.infer<typeof settingsSchema>;

export const exportsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().max(200).optional() }).strict();
export type ExportsQuery = z.infer<typeof exportsQuerySchema>;
