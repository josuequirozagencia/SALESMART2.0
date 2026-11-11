import { z } from 'zod';

/** Cómo se elige el calendario: `own` = Sales Smart crea el suyo (solo permisos no sensibles); `existing` = la persona elige uno que ya tiene. */
export const startSchema = z.strictObject({ mode: z.enum(['own', 'existing']) });
export type StartDto = z.infer<typeof startSchema>;

export const chooseSchema = z.strictObject({ calendar_id: z.string().trim().min(1).max(300) });
export type ChooseDto = z.infer<typeof chooseSchema>;

/** Lo que Google agrega al volver (`code`, `state`, o `error`; más `scope`, `authuser`…, que se ignoran). Ninguno se registra. */
export const callbackQuerySchema = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(600).optional(),
  error: z.string().max(100).optional(),
});
export type CallbackQuery = z.infer<typeof callbackQuerySchema>;
