// F2 — Tareas que se repiten y avisos de tareas (ADR-58). Las rutas son las de ADR-48 (cubiertas en crm-extras.test.ts); aquí van la repetición, los avisos y su tarea periódica.
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ContactsModule } from '../../src/modules/contacts';
import { CustomFieldsModule } from '../../src/modules/custom-fields';
import { NotificationsModule } from '../../src/modules/notifications';
import { OrganizationsModule } from '../../src/modules/organizations';
import { TaskNoticesModule, TaskNoticesService } from '../../src/modules/task-notices';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, CustomFieldsModule, NotificationsModule, TaskNoticesModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  erin: 'e0000000-0000-4000-8000-0000000000e5', // otra asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const NOBODY = '11111111-1111-4111-8111-111111111111';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** La hora de pared de Guayaquil (UTC−5 fijo) → instante. */
const gye = (iso: string): string => new Date(`${iso}-05:00`).toISOString();
const inMs = (ms: number): string => new Date(Date.now() + ms).toISOString();

interface TaskV {
  id: string;
  title: string;
  due_at: string | null;
  status: 'open' | 'done';
  assignee: { id: string; name: string };
  contact: { id: string; name: string } | null;
  remind_before_minutes: number | null;
  recurrence: { freq: string; interval: number; weekdays: number[] | null; day_of_month: number | null; ends: { kind: string; date?: string; count?: number }; occurrence_no: number; occurrences_created: number } | null;
  next_task?: TaskV | null;
}
interface Err { error: { code: string; message: string; details: Array<{ path: string; code: string; message: string }> } }
interface Notice { id: string; type: string; read_at: string | null; actor: { id: string; name: string } | null; conversation: unknown; task: { id: string; title: string; due_at: string | null; status: string; contact_id: string | null } | null }
interface NoticePage { items: Notice[]; unread: number | null }

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'erin' | 'bob' | 'root', string>;
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE tasks, task_recurrences, notifications, notes, contact_companies, companies, contact_import_rows, contact_imports, contact_list_members, contact_lists, contact_tags, tags, meta_events, custom_field_values, custom_field_definitions, contact_phones, contacts, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  const users: Array<[string, string, string]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.erin, 'erin@a.test', 'Erika Mora'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.root, 'root@plat.test', 'Root']];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.erin, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
}

const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const ok = async <X,>(r: Response, status = 200): Promise<X> => {
  expect(r.status, JSON.stringify(await r.clone().json().catch(() => null))).toBe(status);
  return json<X>(r);
};
const errOf = async (r: Response): Promise<Err['error']> => (await json<Err>(r)).error;
const mkTask = (t: string, body: Record<string, unknown>): Promise<TaskV> => call('POST', '/tasks', t, body).then((r) => ok<TaskV>(r, 201));
const complete = (t: string, id: string): Promise<TaskV> => call('POST', `/tasks/${id}/complete`, t).then((r) => ok<TaskV>(r));
const notices = async (t: string): Promise<NoticePage> => ok<NoticePage>(await call('GET', '/notifications', t));
const count = async (sql: string, params: unknown[] = []): Promise<number> => (await admin.query(sql, params)).rows[0].n as number;
const weekly = { freq: 'weekly', interval: 1 };
const DUE = gye('2030-01-02T21:00:00'); // miércoles 21:00 en Guayaquil (jueves en UTC)

/** Corre la tarea periódica de avisos de vencimiento de la empresa A como si fuera `now`. */
const runDue = (now: Date): Promise<number> => TenantContext.run({ organizationId: ORG_A }, () => app.get(TaskNoticesService, { strict: false }).runDue(now, new Set([IDS.alice, IDS.carol, IDS.erin])));
/** Adelanta el momento del aviso de una tarea (simula que pasó el tiempo). */
const dueNow = (id: string): Promise<unknown> => admin.query(`UPDATE tasks SET notice_at = now() - interval '1 minute' WHERE id = $1`, [id]);

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => {
  await app.close();
  await admin.end();
  process.env = saved;
});
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), erin: await login('erin@a.test'), bob: await login('bob@b.test'), root: await login('root@plat.test') };
});

describe('crear una tarea que se repite', () => {
  it('la regla se valida en el servidor: sin vencimiento, «cada 0», días en una diaria, «tras 1 vez» o campos de más son 400 y no crean nada', async () => {
    const bad: Array<Record<string, unknown>> = [
      { title: 'Sin fecha', recurrence: weekly },
      { title: 'Cada cero', due_at: DUE, recurrence: { freq: 'daily', interval: 0 } },
      { title: 'Demasiado', due_at: DUE, recurrence: { freq: 'daily', interval: 31 } },
      { title: 'Días en diaria', due_at: DUE, recurrence: { freq: 'daily', interval: 1, weekdays: [1] } },
      { title: 'Día 7', due_at: DUE, recurrence: { freq: 'weekly', interval: 1, weekdays: [7] } },
      { title: 'Una vez', due_at: DUE, recurrence: { freq: 'daily', interval: 1, ends: { kind: 'after', count: 1 } } },
      { title: 'Fecha mala', due_at: DUE, recurrence: { freq: 'daily', interval: 1, ends: { kind: 'on', date: 'mañana' } } },
      { title: 'Extra', due_at: DUE, recurrence: { freq: 'daily', interval: 1, otra: true } },
      { title: 'Aviso raro', due_at: DUE, remind_before_minutes: 30 },
    ];
    for (const b of bad) expect((await call('POST', '/tasks', T.alice, b)).status, JSON.stringify(b)).toBe(400);
    expect(await count('SELECT count(*)::int n FROM tasks')).toBe(0);
    expect(await count('SELECT count(*)::int n FROM task_recurrences')).toBe(0);
  });

  it('la semanal sin días toma el del vencimiento EN LA ZONA DE LA EMPRESA (miércoles, no jueves de UTC); la mensual, su día del mes', async () => {
    const w = await mkTask(T.alice, { title: 'Reporte semanal', due_at: DUE, recurrence: weekly });
    expect(w.recurrence).toMatchObject({ freq: 'weekly', interval: 1, weekdays: [3], occurrence_no: 1, occurrences_created: 1, ends: { kind: 'never' } });
    const m = await mkTask(T.alice, { title: 'Cierre mensual', due_at: gye('2030-01-31T21:00:00'), recurrence: { freq: 'monthly', interval: 1 } });
    expect(m.recurrence).toMatchObject({ freq: 'monthly', day_of_month: 31, weekdays: null });
    const view = await ok<TaskV>(await call('GET', `/tasks/${w.id}`, T.alice));
    expect(view.recurrence?.freq).toBe('weekly');
    expect(await count('SELECT count(*)::int n FROM task_recurrences')).toBe(2);
  });

  it('crear la serie y la tarea es una sola acción: la creación de la serie queda en la auditoría y la tarea lleva su número', async () => {
    const t = await mkTask(T.alice, { title: 'Seguimiento', due_at: DUE, recurrence: { freq: 'daily', interval: 2, ends: { kind: 'after', count: 5 } } });
    const row = (await admin.query('SELECT recurrence_id, occurrence_no FROM tasks WHERE id = $1', [t.id])).rows[0];
    expect(row.occurrence_no).toBe(1);
    const log = (await admin.query(`SELECT new_value FROM audit_logs WHERE entity_type = 'task_recurrence' AND entity_id = $1`, [row.recurrence_id])).rows;
    expect(log).toHaveLength(1);
    expect(log[0].new_value).toMatchObject({ freq: 'daily', interval: 2, ends: { kind: 'after', count: 5 } });
  });
});

describe('completar: nace la siguiente', () => {
  it('copia título, responsable, contacto y aviso anticipado; la fecha es la siguiente de la regla a la misma hora; queda UNA abierta y se audita como acción automática', async () => {
    const contact = await ok<{ id: string }>(await call('POST', '/contacts', T.alice, { name: 'Ana Torres', phones: ['+593987000111'] }), 201);
    const t = await mkTask(T.alice, { title: 'Llamar a Ana', description: 'Confirmar pedido', due_at: DUE, assignee_id: IDS.carol, contact_id: contact.id, remind_before_minutes: 60, recurrence: weekly });
    const done = await complete(T.alice, t.id);
    expect(done.status).toBe('done');
    const next = done.next_task!;
    expect(next).toBeTruthy();
    expect(next).toMatchObject({ title: 'Llamar a Ana', status: 'open', remind_before_minutes: 60, recurrence: { occurrence_no: 2, occurrences_created: 2 } });
    expect(next.assignee.id).toBe(IDS.carol);
    expect(next.contact?.id).toBe(contact.id);
    expect(next.due_at).toBe(gye('2030-01-09T21:00:00')); // el miércoles siguiente, 21:00 de Guayaquil
    expect((await admin.query('SELECT description FROM tasks WHERE id = $1', [next.id])).rows[0].description).toBe('Confirmar pedido');
    expect(await count(`SELECT count(*)::int n FROM tasks WHERE status = 'open' AND recurrence_id IS NOT NULL`)).toBe(1);
    const log = (await admin.query(`SELECT source FROM audit_logs WHERE entity_type = 'task' AND entity_id = $1`, [next.id])).rows;
    expect(log).toHaveLength(1);
    expect(log[0].source).toBe('automation');
  });

  it('completar otra vez no crea otra: devuelve la misma siguiente; cinco a la vez crean UNA sola', async () => {
    const t = await mkTask(T.alice, { title: 'Una sola', due_at: DUE, recurrence: weekly });
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => call('POST', `/tasks/${t.id}/complete`, T.alice)));
    const bodies = await Promise.all(rs.map((r) => ok<TaskV>(r)));
    expect(new Set(bodies.map((b) => b.next_task?.id)).size).toBe(1);
    expect(await count('SELECT count(*)::int n FROM tasks')).toBe(2);
    const again = await complete(T.alice, t.id);
    expect(again.next_task?.id).toBe(bodies[0]!.next_task?.id);
    expect(await count('SELECT count(*)::int n FROM tasks')).toBe(2);
  });

  it('completada con atraso salta lo vencido: no nacen tareas vencidas, nace la próxima fecha de la regla posterior a ahora', async () => {
    const t = await mkTask(T.alice, { title: 'Diaria atrasada', due_at: inMs(-3 * DAY), recurrence: { freq: 'daily', interval: 1 } });
    const next = (await complete(T.alice, t.id)).next_task!;
    const at = new Date(next.due_at!).getTime();
    expect(at).toBeGreaterThan(Date.now());
    expect(at - Date.now()).toBeLessThanOrEqual(DAY + 1000);
    expect(next.due_at!.slice(10)).toBe(new Date(t.due_at!).toISOString().slice(10)); // la misma hora de pared
    expect(await count(`SELECT count(*)::int n FROM tasks WHERE status = 'open' AND due_at < now()`)).toBe(0);
  });

  it('una tarea que no se repite no trae «next_task»; completar no cambia lo demás', async () => {
    const t = await mkTask(T.alice, { title: 'Normal', due_at: inMs(DAY) });
    const done = await complete(T.alice, t.id);
    expect(done.next_task).toBeUndefined();
    expect(done.recurrence).toBeNull();
    expect(await count('SELECT count(*)::int n FROM tasks')).toBe(1);
  });

  it('«tras 2 veces»: la segunda ya no crea otra y la serie termina como «completed»; «hasta» una fecha pasada también', async () => {
    const t = await mkTask(T.alice, { title: 'Dos veces', due_at: DUE, recurrence: { freq: 'daily', interval: 1, ends: { kind: 'after', count: 2 } } });
    const second = (await complete(T.alice, t.id)).next_task!;
    expect(second.recurrence?.occurrence_no).toBe(2);
    const last = await complete(T.alice, second.id);
    expect(last.next_task).toBeNull();
    expect(last.recurrence).toBeNull(); // la serie ya terminó
    expect((await admin.query('SELECT ended_reason FROM task_recurrences')).rows[0].ended_reason).toBe('completed');
    const u = await mkTask(T.alice, { title: 'Hasta ayer', due_at: DUE, recurrence: { freq: 'daily', interval: 1, ends: { kind: 'on', date: '2030-01-02' } } });
    expect((await complete(T.alice, u.id)).next_task).toBeNull();
  });
});

describe('editar, detener y borrar', () => {
  it('«recurrence: null» detiene la repetición: la tarea actual sigue y al completarla no nace otra; la serie queda «stopped»', async () => {
    const t = await mkTask(T.alice, { title: 'Detener', due_at: DUE, recurrence: weekly });
    const patched = await ok<TaskV>(await call('PATCH', `/tasks/${t.id}`, T.alice, { recurrence: null }));
    expect(patched.recurrence).toBeNull();
    expect((await complete(T.alice, t.id)).next_task).toBeNull();
    expect(await count('SELECT count(*)::int n FROM tasks')).toBe(1);
    expect((await admin.query('SELECT ended_reason FROM task_recurrences')).rows[0].ended_reason).toBe('stopped');
  });

  it('una tarea normal puede empezar a repetirse; cambiar la regla vale desde la siguiente; quitar el vencimiento de una que se repite es 400', async () => {
    const t = await mkTask(T.alice, { title: 'Empezar', due_at: DUE });
    const started = await ok<TaskV>(await call('PATCH', `/tasks/${t.id}`, T.alice, { recurrence: weekly }));
    expect(started.recurrence?.occurrence_no).toBe(1);
    const changed = await ok<TaskV>(await call('PATCH', `/tasks/${t.id}`, T.alice, { recurrence: { freq: 'daily', interval: 3 } }));
    expect(changed.recurrence).toMatchObject({ freq: 'daily', interval: 3 });
    expect(changed.due_at).toBe(started.due_at); // la actual no se mueve
    expect(await count('SELECT count(*)::int n FROM task_recurrences')).toBe(1); // misma serie
    const r = await call('PATCH', `/tasks/${t.id}`, T.alice, { due_at: null });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details[0]?.code).toBe('recurrence_requires_due');
    const next = (await complete(T.alice, t.id)).next_task!;
    expect(next.due_at).toBe(gye('2030-01-05T21:00:00')); // cada 3 días desde el 2
  });

  it('cambiar la fecha de la abierta mueve la serie: la siguiente se calcula desde ese vencimiento', async () => {
    const t = await mkTask(T.alice, { title: 'Mover', due_at: DUE, recurrence: { freq: 'daily', interval: 1 } });
    await ok(await call('PATCH', `/tasks/${t.id}`, T.alice, { due_at: gye('2030-02-10T08:00:00') }));
    expect((await complete(T.alice, t.id)).next_task?.due_at).toBe(gye('2030-02-11T08:00:00'));
  });

  it('la repetición solo se cambia en una tarea pendiente (en una completada, 400)', async () => {
    const t = await mkTask(T.alice, { title: 'Hecha', due_at: DUE });
    await complete(T.alice, t.id);
    const r = await call('PATCH', `/tasks/${t.id}`, T.alice, { recurrence: weekly });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details[0]?.code).toBe('task_not_open');
  });

  it('borrar la tarea abierta de una serie termina la serie («deleted»)', async () => {
    const t = await mkTask(T.alice, { title: 'Borrar', due_at: DUE, recurrence: weekly });
    await ok(await call('DELETE', `/tasks/${t.id}`, T.alice));
    expect((await admin.query('SELECT ended_reason FROM task_recurrences')).rows[0].ended_reason).toBe('deleted');
  });

  it('reabrir una completada cuya siguiente ya existe es 409 TASK_SUCCESSOR_EXISTS; si la serie ya terminó, se puede reabrir', async () => {
    const t = await mkTask(T.alice, { title: 'Reabrir', due_at: DUE, recurrence: weekly });
    const next = (await complete(T.alice, t.id)).next_task!;
    const r = await call('POST', `/tasks/${t.id}/reopen`, T.alice);
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe('TASK_SUCCESSOR_EXISTS');
    await ok(await call('PATCH', `/tasks/${next.id}`, T.alice, { recurrence: null }));
    await ok(await call('DELETE', `/tasks/${next.id}`, T.alice)); // sin sucesora vigente
    const back = await ok<TaskV>(await call('POST', `/tasks/${t.id}/reopen`, T.alice));
    expect(back.status).toBe('open');
  });

  it('la BD respalda la regla: no admite dos abiertas por serie ni la misma ocurrencia dos veces', async () => {
    const t = await mkTask(T.alice, { title: 'Respaldo', due_at: DUE, recurrence: weekly });
    const rec = (await admin.query('SELECT recurrence_id FROM tasks WHERE id = $1', [t.id])).rows[0].recurrence_id as string;
    await expect(admin.query(`INSERT INTO tasks(organization_id, id, title, assignee_id, created_by, recurrence_id, occurrence_no) VALUES ($1, gen_random_uuid(), 'otra', $2, $2, $3, 2)`, [ORG_A, IDS.alice, rec])).rejects.toThrow(/tasks_recurrence_open_uq/);
    await expect(admin.query(`INSERT INTO tasks(organization_id, id, title, assignee_id, created_by, status, completed_at, recurrence_id, occurrence_no) VALUES ($1, gen_random_uuid(), 'otra', $2, $2, 'done', now(), $3, 1)`, [ORG_A, IDS.alice, rec])).rejects.toThrow(/tasks_recurrence_occurrence_uq/);
  });
});

describe('aislamiento A↔B y alcance por persona', () => {
  it('una tarea y su serie de A no existen para B (404 al ver, editar, completar, reabrir o borrar) y los avisos de A no llegan a B', async () => {
    const t = await mkTask(T.alice, { title: 'Solo de A', due_at: DUE, assignee_id: IDS.carol, recurrence: weekly });
    for (const [m, p, b] of [['GET', `/tasks/${t.id}`], ['PATCH', `/tasks/${t.id}`, { recurrence: null }], ['POST', `/tasks/${t.id}/complete`], ['POST', `/tasks/${t.id}/reopen`], ['DELETE', `/tasks/${t.id}`]] as Array<[string, string, unknown?]>) {
      expect((await call(m, p, T.bob, b)).status, `${m} ${p}`).toBe(404);
    }
    expect((await notices(T.bob)).items).toEqual([]);
    expect((await notices(T.carol)).items).toHaveLength(1);
    // La RLS no deja a B ni leer las filas de A (rol de la aplicación sin acceso entre empresas)
    expect(await count('SELECT count(*)::int n FROM task_recurrences WHERE organization_id = $1', [ORG_A])).toBe(1);
  });

  it('la asesora crea y completa SUS tareas que se repiten; otra asesora no las ve (404) y no puede asignarle una a otra persona', async () => {
    const t = await mkTask(T.carol, { title: 'De Carolina', due_at: DUE, recurrence: weekly });
    expect((await complete(T.carol, t.id)).next_task).toBeTruthy();
    expect((await call('GET', `/tasks/${t.id}`, T.erin)).status).toBe(404);
    expect((await call('POST', '/tasks', T.carol, { title: 'Para Erika', assignee_id: IDS.erin, due_at: DUE })).status).toBe(403);
  });
});

describe('aviso «te asignaron una tarea»', () => {
  it('quien asigna a OTRA persona le crea el aviso (con quién se la asignó); a sí mismo, ninguno; reasignar avisa a la nueva persona; el aviso no guarda el título', async () => {
    const t = await mkTask(T.alice, { title: 'Preparar la propuesta', assignee_id: IDS.carol, due_at: inMs(DAY) });
    await mkTask(T.alice, { title: 'Mía', due_at: inMs(DAY) });
    const carol = await notices(T.carol);
    expect(carol.unread).toBe(1);
    expect(carol.items[0]).toMatchObject({ type: 'task_assigned', read_at: null, conversation: null, task: { id: t.id, title: 'Preparar la propuesta', status: 'open' } });
    expect(carol.items[0]!.actor?.name).toBe('Alicia Torres');
    expect((await notices(T.alice)).items).toEqual([]);
    await ok(await call('PATCH', `/tasks/${t.id}`, T.alice, { assignee_id: IDS.erin }));
    expect((await notices(T.erin)).items).toHaveLength(1);
    expect((await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'notifications' AND column_name IN ('title','body','text')`)).rows).toEqual([]);
  });

  it('se oculta cuando la tarea se borra o deja de ser suya; el contador solo cuenta lo visible; se puede marcar leído', async () => {
    const t = await mkTask(T.alice, { title: 'Temporal', assignee_id: IDS.carol, due_at: inMs(DAY) });
    const u = await mkTask(T.alice, { title: 'Se queda', assignee_id: IDS.carol, due_at: inMs(DAY) });
    expect((await notices(T.carol)).unread).toBe(2);
    await ok(await call('DELETE', `/tasks/${t.id}`, T.alice));
    const after = await notices(T.carol);
    expect(after.unread).toBe(1);
    expect(after.items.map((i) => i.task?.title)).toEqual(['Se queda']);
    await ok(await call('POST', `/notifications/${after.items[0]!.id}/read`, T.carol));
    expect((await notices(T.carol)).unread).toBe(0);
    await ok(await call('PATCH', `/tasks/${u.id}`, T.alice, { assignee_id: IDS.erin }));
    expect((await notices(T.carol)).items).toEqual([]); // ya no es suya
  });

  it('un aviso de tarea es de su destinatario: otra persona (ni el administrador) no lo ve ni lo marca', async () => {
    await mkTask(T.alice, { title: 'Privada', assignee_id: IDS.carol, due_at: inMs(DAY) });
    const id = (await notices(T.carol)).items[0]!.id;
    expect((await notices(T.alice)).items).toEqual([]);
    expect((await call('POST', `/notifications/${id}/read`, T.alice)).status).toBe(404);
    expect((await call('POST', `/notifications/${id}/read`, T.bob)).status).toBe(404);
  });
});

describe('aviso de vencimiento y su tarea periódica', () => {
  it('al crear se arma «cuándo avisar»: al vencer, o antes si se pidió; sin vencimiento o con ese momento ya pasado, nada', async () => {
    const due = Date.now() + 3 * HOUR;
    const a = await mkTask(T.alice, { title: 'Al vencer', due_at: new Date(due).toISOString() });
    const b = await mkTask(T.alice, { title: 'Una hora antes', due_at: new Date(due).toISOString(), remind_before_minutes: 60 });
    const c = await mkTask(T.alice, { title: 'Sin fecha' });
    const d = await mkTask(T.alice, { title: 'Ya vencida', due_at: inMs(-HOUR) });
    const e = await mkTask(T.alice, { title: 'Aviso ya pasado', due_at: inMs(30 * 60_000), remind_before_minutes: 60 });
    const at = async (id: string): Promise<number | null> => {
      const v = (await admin.query('SELECT notice_at FROM tasks WHERE id = $1', [id])).rows[0].notice_at as Date | null;
      return v ? v.getTime() : null;
    };
    expect(await at(a.id)).toBe(due);
    expect(await at(b.id)).toBe(due - HOUR);
    expect(await at(c.id)).toBeNull();
    expect(await at(d.id)).toBeNull();
    expect(await at(e.id)).toBeNull();
  });

  it('cuando llega la hora, la tarea periódica crea UN aviso para el responsable y limpia «cuándo avisar»; repetirla no duplica', async () => {
    const t = await mkTask(T.alice, { title: 'Reunión con proveedor', assignee_id: IDS.carol, due_at: inMs(2 * HOUR) });
    expect(await runDue(new Date())).toBe(0); // todavía no toca
    await dueNow(t.id);
    expect(await runDue(new Date())).toBe(1);
    expect(await runDue(new Date())).toBe(0);
    const due = (await notices(T.carol)).items.filter((i) => i.type === 'task_due');
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ actor: null, task: { id: t.id, title: 'Reunión con proveedor' } });
    expect(await count(`SELECT count(*)::int n FROM notifications WHERE type = 'task_due'`)).toBe(1);
    expect((await notices(T.alice)).items).toEqual([]);
  });

  it('una tarea completada o borrada antes de la hora no avisa; el aviso de una completada después se oculta', async () => {
    const done = await mkTask(T.alice, { title: 'Hecha a tiempo', assignee_id: IDS.carol, due_at: inMs(2 * HOUR) });
    const gone = await mkTask(T.alice, { title: 'Borrada', assignee_id: IDS.carol, due_at: inMs(2 * HOUR) });
    const late = await mkTask(T.alice, { title: 'Hecha después', assignee_id: IDS.carol, due_at: inMs(2 * HOUR) });
    await complete(T.carol, done.id);
    await ok(await call('DELETE', `/tasks/${gone.id}`, T.alice));
    await dueNow(late.id);
    await dueNow(done.id);
    await dueNow(gone.id);
    expect(await runDue(new Date())).toBe(1);
    const titles = (await notices(T.carol)).items.filter((i) => i.type === 'task_due').map((i) => i.task?.title);
    expect(titles).toEqual(['Hecha después']);
    await complete(T.carol, late.id);
    expect((await notices(T.carol)).items.filter((i) => i.type === 'task_due')).toEqual([]);
  });

  it('cambiar el vencimiento o el aviso anticipado vuelve a armar el aviso; si ese momento ya pasó, queda sin avisar; reasignar avisa a la nueva persona', async () => {
    const t = await mkTask(T.alice, { title: 'Re-armar', assignee_id: IDS.carol, due_at: inMs(5 * HOUR) });
    await dueNow(t.id);
    await runDue(new Date());
    expect((await notices(T.carol)).items.filter((i) => i.type === 'task_due')).toHaveLength(1);
    await ok(await call('PATCH', `/tasks/${t.id}`, T.alice, { due_at: inMs(8 * HOUR), remind_before_minutes: 15 }));
    expect((await admin.query('SELECT notice_at FROM tasks WHERE id = $1', [t.id])).rows[0].notice_at).not.toBeNull();
    await ok(await call('PATCH', `/tasks/${t.id}`, T.alice, { due_at: inMs(-HOUR) })); // fecha en el pasado a propósito
    expect((await admin.query('SELECT notice_at FROM tasks WHERE id = $1', [t.id])).rows[0].notice_at).toBeNull();
    await ok(await call('PATCH', `/tasks/${t.id}`, T.alice, { due_at: inMs(6 * HOUR), assignee_id: IDS.erin }));
    await dueNow(t.id);
    await runDue(new Date());
    expect((await notices(T.erin)).items.map((i) => i.type).sort()).toEqual(['task_assigned', 'task_due']);
  });

  it('el aviso anticipado por omisión es «al vencer» y solo admite 15, 60 o 1440 minutos; la siguiente de una serie hereda el anticipo y arma su propio aviso', async () => {
    const t = await mkTask(T.alice, { title: 'Con anticipo', due_at: inMs(2 * DAY), remind_before_minutes: 1440, recurrence: { freq: 'daily', interval: 1 } });
    const next = (await complete(T.alice, t.id)).next_task!;
    expect(next.remind_before_minutes).toBe(1440);
    const at = (await admin.query('SELECT notice_at, due_at FROM tasks WHERE id = $1', [next.id])).rows[0] as { notice_at: Date; due_at: Date };
    expect(at.due_at.getTime() - at.notice_at.getTime()).toBe(DAY);
    expect((await call('PATCH', `/tasks/${t.id}`, T.alice, { remind_before_minutes: 5 })).status).toBe(400);
  });

  it('solo avisa a quien todavía puede recibir trabajo: una persona desactivada no recibe el aviso, pero se limpia el pendiente', async () => {
    const t = await mkTask(T.alice, { title: 'Sin destinatario', assignee_id: IDS.carol, due_at: inMs(2 * HOUR) });
    await dueNow(t.id);
    const n = await TenantContext.run({ organizationId: ORG_A }, () => app.get(TaskNoticesService, { strict: false }).runDue(new Date(), new Set([IDS.alice])));
    expect(n).toBe(1);
    expect(await count(`SELECT count(*)::int n FROM notifications WHERE type = 'task_due'`)).toBe(0);
    expect((await admin.query('SELECT notice_at FROM tasks WHERE id = $1', [t.id])).rows[0].notice_at).toBeNull();
  });
});

describe('permisos y rutas', () => {
  it('sin sesión 401 y la plataforma 403', async () => {
    for (const [m, p] of [['POST', '/tasks'], ['PATCH', `/tasks/${NOBODY}`], ['POST', `/tasks/${NOBODY}/complete`]] as Array<[string, string]>) {
      expect((await call(m, p, undefined, {})).status).toBe(401);
      expect((await call(m, p, T.root, {})).status).toBe(403);
    }
  });
});
