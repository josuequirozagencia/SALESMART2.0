import { Inject, Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { AppConfig } from '../../config';
import { conversationParticipants, conversations, Database } from '../../db';
import { WindowLimiter } from '../../http';
import type { AppLogger } from '../../logger';
import { TenantContext } from '../../tenant';
import { APP_CONFIG, APP_LOGGER } from '../../tokens';
import { SessionService } from '../auth';
import { OrgMembersService } from '../organizations';
import { personRoom, type RealtimeEnvelope, type RealtimeEvent, type TouchOptions } from './realtime.types';

export const REALTIME_PATH = '/v1/realtime';
/** Cuántas pestañas/dispositivos a la vez por persona; al pasarse se cierra la más antigua. */
export const MAX_SOCKETS_PER_USER = 3;
/** Conexiones nuevas por minuto y por IP (el handshake, no cada petición del transporte). */
const HANDSHAKES_PER_MINUTE = 30;
/** Cada cuánto se vuelve a comprobar que la sesión sigue vigente y en la misma empresa. */
const REVALIDATE_MS = 60_000;
/** Espera antes de avisar: junta ráfagas y deja que termine la transacción que cambió el dato. */
const DELAY_MS = 250;
const FLUSH_EVERY_MS = 100;
/** Si un mensaje cambia muchas veces en la misma ráfaga, basta con avisar de la conversación. */
const MAX_MESSAGES_PER_BURST = 20;
const PERMISSION_TTL_MS = 5_000;
const KNOWN_TTL_MS = 10 * 60_000;
const KNOWN_MAX = 5_000;

interface Pending {
  organizationId: string;
  conversationId: string;
  due: number;
  created: boolean;
  scheduled: boolean;
  messages: Map<string, 'created' | 'updated'>;
  also: Set<string>;
}

interface SocketData {
  userId: string;
  organizationId: string;
  token: string;
}

/** Dirección del cliente según los saltos de proxy de confianza (los mismos que usa Express). */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, hops: number): string {
  const direct = req.socket.remoteAddress ?? 'unknown';
  if (hops <= 0) return direct;
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  // Cada proxy de confianza añade la dirección de quien le habló: la del cliente real es la que queda `hops` posiciones desde el final
  return (forwarded.length >= hops ? forwarded[forwarded.length - hops] : forwarded[0]) ?? direct;
}

function bearer(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.replace(/^Bearer\s+/i, '').trim();
  return t.length > 0 && t.length <= 512 ? t : undefined;
}

/**
 * Tiempo real del Inbox (M5.7, ADR-50 #6): Socket.IO en el mismo proceso, sin Redis. La misma sesión que la API; cada persona entra en la sala de SU empresa
 * (`org:{id}:user:{id}`) y cada aviso se manda solo a quienes pueden ver esa conversación (dueño, colaboradores vigentes y quien ve todo). Los avisos llevan
 * solo identificadores: el cliente vuelve a pedir el dato por la API, que aplica la visibilidad y el aislamiento de siempre.
 */
@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnModuleDestroy {
  private io: Server | null = null;
  private readonly limiter = new WindowLimiter(HANDSHAKES_PER_MINUTE, 60_000);
  private readonly pending = new Map<string, Pending>();
  private readonly known = new Map<string, { at: number; users: Set<string> }>();
  private readonly perms = new Map<string, { at: number; ids: string[] }>();
  private flushTimer: NodeJS.Timeout | null = null;
  private revalidateTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
    @Inject(Database) private readonly db: Database,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
  ) {}

  onApplicationBootstrap(): void {
    const server = this.host.httpAdapter?.getHttpServer() as HttpServer | undefined;
    if (!server) return;
    // Sin `cors`: el navegador solo puede conectarse desde el mismo origen; la autenticación va en el handshake, no en cookies
    const io = new Server(server, { path: REALTIME_PATH, serveClient: false, transports: ['websocket', 'polling'], maxHttpBufferSize: 1_000 });
    this.io = io;
    io.use((socket, next) => {
      this.authenticate(socket).then(
        () => next(),
        () => next(new Error('unauthorized')),
      );
    });
    io.on('connection', (socket) => void this.onConnection(socket));
    this.flushTimer = setInterval(() => void this.flushDue(), FLUSH_EVERY_MS);
    this.flushTimer.unref();
    this.revalidateTimer = setInterval(() => void this.revalidate(), REVALIDATE_MS);
    this.revalidateTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.revalidateTimer) clearInterval(this.revalidateTimer);
    const io = this.io;
    this.io = null;
    if (io) await new Promise<void>((resolve) => void io.close(() => resolve()));
  }

  /** Cuántas conexiones hay ahora (para pruebas y diagnóstico). */
  connections(): number {
    return this.io?.sockets.sockets.size ?? 0;
  }

  // ---------------------------------------------------------------- conexión

  private async authenticate(socket: Socket): Promise<void> {
    const req = socket.request;
    const ip = clientIp(req, this.cfg.trustProxyHops).slice(0, 80);
    if (!this.limiter.take(ip).ok) throw new Error('rate_limited');
    const auth = socket.handshake.auth as Record<string, unknown> | undefined;
    const token = bearer(auth?.['token']) ?? bearer(req.headers['authorization']);
    const ctx = await this.sessions.authenticate(token);
    if (!token || !ctx) throw new Error('unauthorized');
    const data: SocketData = { userId: ctx.userId, organizationId: ctx.organizationId, token };
    socket.data = data;
  }

  private async onConnection(socket: Socket): Promise<void> {
    const { userId, organizationId } = socket.data as SocketData;
    const room = personRoom(organizationId, userId);
    await socket.join(room);
    // Tope por persona: se cierra la más antigua
    const io = this.io;
    if (!io) return;
    const mine = [...(io.sockets.adapter.rooms.get(room) ?? [])];
    if (mine.length > MAX_SOCKETS_PER_USER) {
      const oldest = io.sockets.sockets.get(mine[0] as string);
      if (oldest && oldest.id !== socket.id) oldest.disconnect(true);
    }
  }

  /** Cierra las conexiones cuya sesión venció, se revocó o ya actúa en otra empresa: el cliente se reconecta con la sesión vigente. */
  private async revalidate(): Promise<void> {
    const io = this.io;
    if (!io) return;
    for (const socket of io.sockets.sockets.values()) {
      const d = socket.data as SocketData;
      try {
        const ctx = await this.sessions.authenticate(d.token);
        if (ctx && ctx.userId === d.userId && ctx.organizationId === d.organizationId) continue;
        socket.emit('auth.expired');
        socket.disconnect(true);
      } catch {
        // un fallo transitorio de la base no debe tumbar conexiones válidas: se reintenta en la próxima vuelta
      }
    }
  }

  // ---------------------------------------------------------------- emisión

  /**
   * Avisa que algo cambió en una conversación. Barata y sin esperar: junta lo que llegue en 250 ms y luego calcula quién debe enterarse.
   * Nunca lanza: el tiempo real es una mejora; si falla, el Inbox sigue funcionando por consulta periódica.
   */
  touch(organizationId: string, conversationId: string, opts: TouchOptions = {}): void {
    if (!this.io) return;
    const key = `${organizationId}:${conversationId}`;
    let p = this.pending.get(key);
    if (!p) {
      p = { organizationId, conversationId, due: Date.now() + DELAY_MS, created: false, scheduled: false, messages: new Map(), also: new Set() };
      this.pending.set(key, p);
    }
    if (opts.created) p.created = true;
    if (opts.scheduled) p.scheduled = true;
    if (opts.message) {
      const prev = p.messages.get(opts.message.id);
      p.messages.set(opts.message.id, prev === 'created' ? 'created' : opts.message.kind);
    }
    for (const u of opts.alsoUsers ?? []) p.also.add(u);
  }

  /** Lo mismo que `touch`, para código que corre dentro de una petición o tarea con contexto de empresa: la empresa sale de ahí, nunca de un parámetro. */
  touchHere(conversationId: string, opts: TouchOptions = {}): void {
    const organizationId = TenantContext.currentOrNull()?.organizationId;
    if (organizationId) this.touch(organizationId, conversationId, opts);
  }

  private async flushDue(): Promise<void> {
    if (!this.io || this.pending.size === 0) return;
    const now = Date.now();
    for (const [key, p] of this.pending) {
      if (p.due > now) continue;
      this.pending.delete(key);
      try {
        await this.deliver(p);
      } catch (e) {
        this.log.warn({ err: e instanceof Error ? e.message : String(e), conversation: p.conversationId }, 'tiempo real: no se pudo avisar');
      }
    }
  }

  private async deliver(p: Pending): Promise<void> {
    const io = this.io;
    if (!io) return;
    const recipients = await this.recipientsOf(p.organizationId, p.conversationId);
    for (const u of p.also) recipients.add(u);
    // Quien lo veía antes (dueño anterior, colaborador retirado) también debe enterarse de que cambió
    const before = this.known.get(`${p.organizationId}:${p.conversationId}`);
    this.remember(p.organizationId, p.conversationId, recipients);
    if (before) for (const u of before.users) recipients.add(u);
    if (recipients.size === 0) return;
    const rooms = [...recipients].map((u) => personRoom(p.organizationId, u));
    const send = (event: RealtimeEvent, messageId?: string): void => {
      const body: RealtimeEnvelope = {
        organization_id: p.organizationId,
        request_id: crypto.randomUUID(),
        at: new Date().toISOString(),
        data: { conversation_id: p.conversationId, ...(messageId ? { message_id: messageId } : {}) },
      };
      io.to(rooms).emit(event, body);
    };
    send(p.created ? 'conversation.created' : 'conversation.updated');
    if (p.messages.size <= MAX_MESSAGES_PER_BURST) for (const [id, kind] of p.messages) send(kind === 'created' ? 'message.created' : 'message.updated', id);
    if (p.scheduled) send('scheduled.updated');
  }

  private remember(organizationId: string, conversationId: string, now: Set<string>): void {
    if (this.known.size >= KNOWN_MAX) {
      const cutoff = Date.now() - KNOWN_TTL_MS;
      for (const [k, v] of this.known) if (v.at < cutoff) this.known.delete(k);
      if (this.known.size >= KNOWN_MAX) this.known.clear();
    }
    this.known.set(`${organizationId}:${conversationId}`, { at: Date.now(), users: new Set(now) });
  }

  /** Quién puede ver la conversación: dueño, colaboradores vigentes y quien ve todo; siempre con permiso de leer el Inbox. Misma regla que `InboxService`. */
  private recipientsOf(organizationId: string, conversationId: string): Promise<Set<string>> {
    return TenantContext.run({ organizationId, requestId: crypto.randomUUID() }, async () => {
      const [c] = await this.db.withTenant((tx) => tx.select({ ownerId: conversations.ownerId }).from(conversations).where(eq(conversations.id, conversationId)).limit(1));
      if (!c) return new Set<string>();
      const set = new Set<string>();
      if (c.ownerId) set.add(c.ownerId);
      const parts = await this.db.withTenant((tx) =>
        tx
          .select({ userId: conversationParticipants.userId })
          .from(conversationParticipants)
          .where(and(eq(conversationParticipants.conversationId, conversationId), isNull(conversationParticipants.revokedAt))),
      );
      for (const x of parts) set.add(x.userId);
      for (const u of await this.usersWith(organizationId, 'inbox.view_all')) set.add(u);
      const canRead = new Set(await this.usersWith(organizationId, 'inbox.read'));
      return new Set([...set].filter((u) => canRead.has(u)));
    });
  }

  /** Quién tiene este permiso en la empresa (con una caché corta). Las tablas de identidad las lee `OrgMembersService`, no este módulo (ADR-25). */
  private async usersWith(organizationId: string, permission: string): Promise<string[]> {
    const key = `${organizationId}:${permission}`;
    const hit = this.perms.get(key);
    if (hit && Date.now() - hit.at < PERMISSION_TTL_MS) return hit.ids;
    const ids = await this.members.withPermission(permission);
    if (this.perms.size > 2_000) this.perms.clear();
    this.perms.set(key, { at: Date.now(), ids });
    return ids;
  }
}
