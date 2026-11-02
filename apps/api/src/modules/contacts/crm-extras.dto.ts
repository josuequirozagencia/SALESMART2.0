import { z } from 'zod';

/** Topes provisionales (ADR-48). */
export const MAX_COMPANIES_PER_CONTACT = 5;
export const MAX_LINK_BATCH = 100;
export const NOTE_PAGE = 30;
export const TASK_PAGE = 25;

const noControl = (v: string): boolean => !/\p{Cc}/u.test(v);
const text = (max: number) => z.string().trim().min(1).max(max).refine(noControl, 'caracteres no permitidos');
/** Texto largo (notas, descripciones): admite saltos de línea y tabulaciones, no otros caracteres de control. */
const longText = (min: number, max: number) => z.string().trim().min(min).max(max).refine((v) => [...v].every((ch) => ch === '\n' || ch === '\r' || ch === '\t' || !/\p{Cc}/u.test(ch)), 'caracteres no permitidos');
const phone = z.string().trim().regex(/^\+[1-9]\d{7,14}$/, 'debe estar en formato internacional, por ejemplo +593987654321');
const email = z.string().trim().max(254).pipe(z.email()).transform((v) => v.toLowerCase());
const website = z.string().trim().min(1).max(200).refine(noControl, 'caracteres no permitidos').refine((v) => !/\s/.test(v), 'no puede tener espacios');
const cursor = z.string().min(1).max(500);

// ── Empresas ────────────────────────────────────────────────────────────────

export const createCompanySchema = z
  .object({ name: text(120), website: website.nullable().optional(), phone: phone.nullable().optional(), email: email.nullable().optional() })
  .strict();
export type CreateCompanyDto = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = z
  .object({ name: text(120).optional(), website: website.nullable().optional(), phone: phone.nullable().optional(), email: email.nullable().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no hay nada que cambiar' });
export type UpdateCompanyDto = z.infer<typeof updateCompanySchema>;

export const listCompaniesQuerySchema = z
  .object({ q: z.string().trim().max(120).optional(), cursor: cursor.optional(), limit: z.coerce.number().int().min(1).max(100).default(25) })
  .strict();
export type ListCompaniesQuery = z.infer<typeof listCompaniesQuerySchema>;

export const linkContactsSchema = z
  .object({ contact_ids: z.array(z.uuid()).min(1).max(MAX_LINK_BATCH).refine((a) => new Set(a).size === a.length, 'hay contactos repetidos') })
  .strict();
export type LinkContactsDto = z.infer<typeof linkContactsSchema>;

export const companyContactsQuerySchema = z.object({ cursor: cursor.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
export type CompanyContactsQuery = z.infer<typeof companyContactsQuerySchema>;

// ── Notas ───────────────────────────────────────────────────────────────────

export const noteBodySchema = z.object({ body: longText(1, 5000) }).strict();
export type NoteBodyDto = z.infer<typeof noteBodySchema>;

export const listNotesQuerySchema = z.object({ cursor: cursor.optional(), limit: z.coerce.number().int().min(1).max(100).default(NOTE_PAGE) }).strict();
export type ListNotesQuery = z.infer<typeof listNotesQuerySchema>;

// ── Tareas ──────────────────────────────────────────────────────────────────

const dueAt = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const description = longText(1, 2000);

/** Cómo se repite una tarea (F2, ADR-58). Días de la semana: 0 = domingo … 6 = sábado. La semanal sin días usa el del vencimiento; la mensual, su día del mes. */
export const recurrenceSchema = z
  .object({
    freq: z.enum(['daily', 'weekly', 'monthly']),
    interval: z.number().int().min(1).max(30).default(1),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    ends: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('never') }).strict(),
        z.object({ kind: z.literal('on'), date: z.iso.date() }).strict(),
        z.object({ kind: z.literal('after'), count: z.number().int().min(2).max(365) }).strict(),
      ])
      .default({ kind: 'never' }),
  })
  .strict()
  .refine((r) => r.freq === 'weekly' || r.weekdays === undefined, { path: ['weekdays'], message: 'solo la repetición semanal lleva días de la semana' });
export type RecurrenceDto = z.infer<typeof recurrenceSchema>;

/** Aviso anticipado del vencimiento: 15 minutos, 1 hora o 1 día antes; `null` = al vencer. */
const remindBefore = z.union([z.literal(15), z.literal(60), z.literal(1440)]).nullable();

export const createTaskSchema = z
  .object({
    title: text(200),
    description: description.nullable().optional(),
    due_at: dueAt.nullable().optional(),
    assignee_id: z.uuid().optional(),
    contact_id: z.uuid().nullable().optional(),
    company_id: z.uuid().nullable().optional(),
    remind_before_minutes: remindBefore.optional(),
    recurrence: recurrenceSchema.nullable().optional(),
  })
  .strict()
  .refine((b) => !(b.contact_id && b.company_id), { path: ['company_id'], message: 'una tarea se vincula a un contacto o a una empresa, no a ambos' })
  .refine((b) => !b.recurrence || !!b.due_at, { path: ['recurrence'], message: 'una tarea que se repite necesita fecha de vencimiento' });
export type CreateTaskDto = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    title: text(200).optional(),
    description: description.nullable().optional(),
    due_at: dueAt.nullable().optional(),
    assignee_id: z.uuid().optional(),
    contact_id: z.uuid().nullable().optional(),
    company_id: z.uuid().nullable().optional(),
    remind_before_minutes: remindBefore.optional(),
    recurrence: recurrenceSchema.nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no hay nada que cambiar' })
  .refine((b) => !(b.contact_id && b.company_id), { path: ['company_id'], message: 'una tarea se vincula a un contacto o a una empresa, no a ambos' });
export type UpdateTaskDto = z.infer<typeof updateTaskSchema>;

export const TASK_SORTS = ['due', 'created'] as const;
export const listTasksQuerySchema = z
  .object({
    status: z.enum(['open', 'done', 'all']).default('open'),
    /** `me` (por defecto), `all` (solo con `contacts.view_all`) o el id de una persona (también solo con `view_all`). */
    assignee: z.union([z.enum(['me', 'all']), z.uuid()]).default('me'),
    overdue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
    contact: z.uuid().optional(),
    company: z.uuid().optional(),
    sort: z.enum(TASK_SORTS).default('due'),
    cursor: cursor.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(TASK_PAGE),
  })
  .strict();
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
