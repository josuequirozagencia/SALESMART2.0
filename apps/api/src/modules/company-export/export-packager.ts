import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { isNotNull, sql } from 'drizzle-orm';
import { Database, knowledgeDocuments, messageAttachments, type TenantTx } from '../../db';
import type { AppLogger } from '../../logger';
import { TenantContext } from '../../tenant';
import { APP_LOGGER } from '../../tokens';
import { StorageError, StorageGateway } from '../attachments';
import { csvLine } from '../contacts';
import { CSV_TABLES, isExcludedColumn, safeEntryName } from './export-policy';
import { ZipFileWriter, ZIP_MAX_ENTRIES, type ZipEntry } from './zip';

/** Un paquete se parte en archivos de hasta este tamaño (ADR-59 #8). */
export const PART_LIMIT_BYTES = 1024 ** 3;
/** Una tabla grande se parte en varias entradas de este tamaño sin comprimir: así ninguna entrada ni parte necesita ZIP64. */
export const ENTRY_LIMIT_BYTES = 64 * 1024 ** 2;
/** Cada cuántas lotes se avisa que el trabajo sigue vivo (renueva el arrendamiento). */
const HEARTBEAT_EVERY = 25;
const ARCHIVOS = 'archivos';
/** Marca de orden de bytes UTF-8: así Excel respeta los acentos de un CSV. */
const BOM = String.fromCharCode(0xfeff);

export interface PackagePerson {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  status: string;
}

export interface PackageInput {
  organizationId: string;
  organizationName: string;
  /** Quien lo pidió (la persona del contexto de lectura). */
  requestedBy: string;
  /** `super_admin` cuando lo pide la plataforma: queda marcado en el contexto de lectura. */
  actingAsSuperAdmin: boolean;
  generatedAt: Date;
  timeZone: string;
  people: PackagePerson[];
  /** Prefijo del almacenamiento donde quedan las partes, p. ej. `org/<id>/exports/<exportId>/`. */
  storagePrefix: string;
  /** Nombre base de la descarga, p. ej. `salesmart-cafe-origen`. */
  downloadBase: string;
}

export interface PackageOptions {
  partLimitBytes?: number;
  entryLimitBytes?: number;
  /** Se llama de vez en cuando mientras trabaja (para renovar el arrendamiento de la tarea). */
  onProgress?: () => Promise<void>;
}

export interface PackagePart {
  n: number;
  key: string;
  filename: string;
  bytes: number;
  entries: number;
}

export interface PackageResult {
  parts: PackagePart[];
  /** Filas escritas por tabla. */
  counts: Record<string, number>;
  files: { included: number; missing: number; skipped: number };
}

interface TableInfo {
  name: string;
  columns: string[];
  excluded: string[];
  rows: number;
}

/**
 * Arma el paquete «Descargar todo» de UNA empresa (F3b, ADR-59 #8): todas sus tablas de negocio (descubiertas del catálogo, sin las columnas sensibles), los CSV de lo que se abre en una hoja de
 * cálculo, los archivos del almacenamiento y un LEEME. Lee SIEMPRE dentro de `TenantContext` + RLS (cada consulta está acotada a esa empresa por la base de datos, no por un filtro que alguien deba
 * recordar) y con un cursor por tabla, así que la memoria no crece con el tamaño de la tabla. Escribe ZIP en disco y sube cada parte al almacenamiento apenas se cierra.
 */
@Injectable()
export class ExportPackager {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(StorageGateway) private readonly storage: StorageGateway,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  async build(input: PackageInput, opts: PackageOptions = {}): Promise<PackageResult> {
    const partLimit = opts.partLimitBytes ?? PART_LIMIT_BYTES;
    const entryLimit = opts.entryLimitBytes ?? ENTRY_LIMIT_BYTES;
    const dir = await mkdtemp(join(tmpdir(), 'ss-export-'));
    const uploaded: string[] = [];
    const parts: PackagePart[] = [];
    const open: { w: ZipFileWriter | null } = { w: null };
    let n = 0;
    let beats = 0;
    const beat = async (): Promise<void> => {
      beats += 1;
      if (beats % HEARTBEAT_EVERY === 0) await opts.onProgress?.();
    };

    const closeCurrent = async (): Promise<void> => {
      const w = open.w;
      if (!w) return;
      open.w = null;
      const entries = w.count;
      const bytes = await w.close();
      const key = `${input.storagePrefix}parte-${String(n).padStart(3, '0')}.zip`;
      await this.storage.putFile(key, w.path, 'application/zip');
      uploaded.push(key);
      parts.push({ n, key, filename: `${input.downloadBase}-parte-${n}.zip`, bytes, entries });
      await rm(w.path, { force: true });
      await opts.onProgress?.();
    };
    /** Un lugar con sitio para `extra` bytes más (abre la primera parte o pasa a la siguiente). */
    const room = async (extra: number): Promise<ZipFileWriter> => {
      if (open.w && open.w.count > 0 && (open.w.bytes + extra > partLimit || open.w.count >= ZIP_MAX_ENTRIES - 2)) await closeCurrent();
      if (!open.w) {
        n += 1;
        open.w = new ZipFileWriter(join(dir, `parte-${n}.zip`));
      }
      return open.w;
    };

    try {
      const tables = await this.readCatalog(input);
      const counts: Record<string, number> = {};

      await (await room(0)).addBuffer('LEEME.txt', readme(input, tables), input.generatedAt);
      await (await room(0)).addBuffer('manifest.json', JSON.stringify({ organization_id: input.organizationId, generated_at: input.generatedAt.toISOString(), tables: tables.map((t) => ({ name: t.name, rows: t.rows, columns: t.columns, excluded_columns: t.excluded })) }, null, 2), input.generatedAt);
      await (await room(0)).addBuffer('usuarios.json', JSON.stringify(input.people, null, 2), input.generatedAt);

      // datos/: un JSON por línea por tabla
      for (const t of tables) {
        counts[t.name] = 0;
        if (t.rows === 0) continue;
        const chunk = new Chunker(room, entryLimit, (i) => `datos/${t.name}${i === 1 ? '' : `.${String(i).padStart(4, '0')}`}.jsonl`);
        await this.readTable(input, t, async (rows) => {
          for (const line of rows) {
            await chunk.line(line);
            counts[t.name] = (counts[t.name] ?? 0) + 1;
          }
          await beat();
        });
        await chunk.finish();
      }

      // csv/: lo que una persona abre en una hoja de cálculo
      for (const c of CSV_TABLES) {
        const t = tables.find((x) => x.name === c.table);
        if (!t || t.rows === 0) continue;
        const header = `${BOM}${csvLine(t.columns)}\r\n`;
        const chunk = new Chunker(room, entryLimit, (i) => `csv/${c.file}${i === 1 ? '' : `.${String(i).padStart(4, '0')}`}.csv`, header);
        await this.readTable(input, t, async (rows) => {
          for (const line of rows) {
            const row = JSON.parse(line) as Record<string, unknown>;
            await chunk.line(csvLine(t.columns.map((col) => row[col])), '\r\n');
          }
          await beat();
        });
        await chunk.finish();
      }

      // archivos/: lo que está en el almacenamiento (adjuntos listos y biblioteca de conocimiento)
      const files = await this.addFiles(input, room, opts.onProgress);

      await closeCurrent();
      return { parts, counts, files };
    } catch (e) {
      if (open.w) await open.w.abort().catch(() => undefined);
      for (const key of uploaded) await this.storage.delete(key).catch(() => undefined);
      throw e;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Cuenta y columnas de cada tabla de negocio de la empresa, del catálogo de PostgreSQL. Una tabla nueva queda cubierta sin tocar nada aquí. */
  private async readCatalog(input: PackageInput): Promise<TableInfo[]> {
    return this.inTenant(input, async (tx) => {
      const res = await tx.execute<{ table_name: string; column_name: string; type_name: string }>(sql`
        SELECT c.relname AS table_name, a.attname AS column_name, t.typname AS type_name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          JOIN pg_type t ON t.oid = a.atttypid
         WHERE c.relkind = 'r'
           AND c.relrowsecurity
           AND has_table_privilege(current_user, c.oid, 'SELECT')
           AND EXISTS (SELECT 1 FROM pg_attribute o WHERE o.attrelid = c.oid AND o.attname = 'organization_id' AND NOT o.attisdropped)
         ORDER BY c.relname, a.attnum`);
      const byTable = new Map<string, TableInfo>();
      for (const r of res.rows) {
        const info = byTable.get(r.table_name) ?? { name: r.table_name, columns: [], excluded: [], rows: 0 };
        (isExcludedColumn(r.column_name, r.type_name) ? info.excluded : info.columns).push(r.column_name);
        byTable.set(r.table_name, info);
      }
      const tables = [...byTable.values()].filter((t) => t.columns.length > 0);
      for (const t of tables) {
        const c = await tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM ${sql.identifier('public')}.${sql.identifier(t.name)}`);
        t.rows = Number(c.rows[0]?.n ?? 0);
      }
      return tables;
    });
  }

  /** Recorre una tabla con un cursor (una transacción de lectura por tabla) y entrega las filas como JSON, de a lotes. */
  private async readTable(input: PackageInput, t: TableInfo, onBatch: (lines: string[]) => Promise<void>): Promise<void> {
    const cols = sql.join(
      t.columns.map((c) => sql.identifier(c)),
      sql`, `,
    );
    await this.inTenant(input, async (tx) => {
      await tx.execute(sql`DECLARE export_cur NO SCROLL CURSOR FOR SELECT to_jsonb(r)::text AS j FROM (SELECT ${cols} FROM ${sql.identifier('public')}.${sql.identifier(t.name)}) AS r`);
      for (;;) {
        const res = await tx.execute<{ j: string }>(sql`FETCH 1000 FROM export_cur`);
        if (res.rows.length === 0) break;
        await onBatch(res.rows.map((r) => r.j));
      }
    });
  }

  private async addFiles(input: PackageInput, room: (extra: number) => Promise<ZipFileWriter>, onProgress?: () => Promise<void>): Promise<PackageResult['files']> {
    const out = { included: 0, missing: 0, skipped: 0 };
    const wanted = await this.inTenant(input, async (tx) => {
      const attachments = await tx
        .select({ id: messageAttachments.id, key: messageAttachments.storageKey, name: messageAttachments.filename, mime: messageAttachments.mimeType, state: messageAttachments.state })
        .from(messageAttachments)
        .where(isNotNull(messageAttachments.storageKey));
      const docs = await tx.select({ id: knowledgeDocuments.id, key: knowledgeDocuments.storageKey, name: knowledgeDocuments.name }).from(knowledgeDocuments).where(isNotNull(knowledgeDocuments.storageKey));
      return [
        ...attachments.map((a) => ({ folder: `${ARCHIVOS}/adjuntos`, id: a.id, key: a.key!, name: a.name ?? `adjunto-${a.id}`, ok: a.state === 'ready' })),
        ...docs.map((d) => ({ folder: `${ARCHIVOS}/biblioteca`, id: d.id, key: d.key, name: d.name, ok: true })),
      ];
    });
    let i = 0;
    for (const f of wanted) {
      i += 1;
      if (!f.ok) {
        out.skipped += 1; // un adjunto que no quedó listo (pendiente, fallido, con virus o vencido) no se entrega
        continue;
      }
      let body: Buffer;
      try {
        body = await this.storage.get(f.key);
      } catch (e) {
        if (e instanceof StorageError && e.code === 'not_found') {
          out.missing += 1;
          continue;
        }
        throw e;
      }
      const zip = await room(body.length + 1024);
      await zip.addBuffer(`${f.folder}/${f.id}-${safeEntryName(f.name, 'archivo')}`, body, input.generatedAt);
      out.included += 1;
      if (i % HEARTBEAT_EVERY === 0) await onProgress?.();
    }
    return out;
  }

  /** Lee dentro de la empresa pedida: la base de datos acota cada consulta (RLS), no un filtro del código. */
  private inTenant<T>(input: PackageInput, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return TenantContext.run({ organizationId: input.organizationId, userId: input.requestedBy, ...(input.actingAsSuperAdmin ? { actingAs: 'super_admin' as const } : {}) }, () => this.db.withTenant(fn));
  }
}

/** Escribe líneas en una entrada y, al llegar al tope sin comprimir, pasa a la siguiente (cada una con su encabezado). */
class Chunker {
  private entry: ZipEntry | null = null;
  private index = 0;

  constructor(
    private readonly room: (extra: number) => Promise<ZipFileWriter>,
    private readonly limit: number,
    private readonly nameOf: (index: number) => string,
    private readonly header: string = '',
  ) {}

  async line(text: string, eol = '\n'): Promise<void> {
    if (this.entry && this.entry.uncompressed >= this.limit) await this.finish();
    if (!this.entry) {
      this.index += 1;
      const zip = await this.room(this.limit);
      this.entry = await zip.begin(this.nameOf(this.index));
      if (this.header) await this.entry.write(this.header);
    }
    await this.entry.write(text + eol);
  }

  async finish(): Promise<void> {
    if (!this.entry) return;
    const e = this.entry;
    this.entry = null;
    await e.end();
  }
}

/** El LEEME que va en la primera parte: qué hay, de cuándo es y qué NO se incluyó (y por qué). */
function readme(input: PackageInput, tables: TableInfo[]): string {
  const when = new Intl.DateTimeFormat('es-EC', { dateStyle: 'full', timeStyle: 'short', timeZone: safeZone(input.timeZone) }).format(input.generatedAt);
  const filled = tables.filter((t) => t.rows > 0);
  const empty = tables.filter((t) => t.rows === 0).map((t) => t.name);
  const excluded = [...new Set(tables.flatMap((t) => t.excluded))].sort();
  const lines = [
    `COPIA COMPLETA DE LOS DATOS DE «${input.organizationName}»`,
    `Generada el ${when} (${input.timeZone}).`,
    '',
    'QUÉ CONTIENE',
    '  datos/        Un archivo por tabla, con una fila por línea en formato JSON (.jsonl). Es la copia completa y fiel. Una tabla muy grande se parte en varios archivos numerados.',
    '  csv/          Lo que se abre en una hoja de cálculo (contactos, teléfonos, conversaciones, oportunidades, ventas, abonos, citas y tareas): las mismas filas, en CSV con acentos correctos.',
    '  archivos/     Los archivos guardados: adjuntos de las conversaciones (solo los que quedaron listos) y los documentos de la biblioteca de conocimiento.',
    '  usuarios.json Las personas que tuvieron acceso a la empresa (para entender los campos de responsable, creado por, etc.).',
    '  manifest.json La lista de tablas, filas y columnas, para procesarla con un programa.',
    '',
    'SI HAY VARIAS PARTES',
    '  El paquete se parte en archivos ZIP de hasta 1 GB. Cada parte es un ZIP completo e independiente; descárguelas todas y descomprímalas en la misma carpeta. Este LEEME solo está en la primera.',
    '',
    'FILAS POR TABLA',
    ...filled.map((t) => `  ${t.name.padEnd(34)} ${String(t.rows).padStart(10)}`),
    ...(empty.length > 0 ? ['', `  Tablas sin filas: ${empty.join(', ')}`] : []),
    '',
    'LO QUE NO SE INCLUYE',
    '  • Credenciales y secretos (claves de acceso, tokens, secretos de firma, contraseñas y cualquier valor cifrado): jamás salen de la plataforma. Para las conexiones solo se conservan los últimos 4 caracteres.',
    '  • Huellas y datos binarios internos (índices de búsqueda de la IA, huellas de archivos y de direcciones).',
    `  Columnas omitidas: ${excluded.length > 0 ? excluded.join(', ') : '(ninguna)'}.`,
    '  • Adjuntos que no quedaron listos (pendientes, fallidos, con virus o vencidos).',
    '',
    'NOTAS',
    '  • Las fechas llevan su zona horaria. Los importes vienen como número con dos decimales y la moneda en su propia columna.',
    '  • La copia se lee tabla por tabla mientras la empresa está detenida, de modo que es consistente.',
    '  • Esta copia se genera antes del borrado definitivo de la empresa; después no se puede volver a pedir.',
  ];
  return `${lines.join('\r\n')}\r\n`;
}

function safeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('es-EC', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

