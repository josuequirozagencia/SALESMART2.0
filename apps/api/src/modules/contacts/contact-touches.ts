import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { contactTouchEvents, Database, type TenantTx } from '../../db';
import { ContactsService, type ContactScope } from './contacts.service';

export type TouchKind = 'ad_click' | 'form_submit' | 'message_in';

/** Un toque a registrar. Todo lo opcional puede faltar (un mensaje orgánico no trae anuncio). */
export interface TouchEventInput {
  kind: TouchKind;
  at: Date;
  source: string;
  campaign?: string | null | undefined;
  adset?: string | null | undefined;
  ad?: string | null | undefined;
  adId?: string | null | undefined;
  ctwaClid?: string | null | undefined;
  headline?: string | null | undefined;
  thumbnailUrl?: string | null | undefined;
  sourceUrl?: string | null | undefined;
  utm?: Record<string, string> | undefined;
  /** El origen (el `ctwa_clid`, el id del envío del formulario o el del mensaje): hace idempotente el registro. */
  originRef?: string | null | undefined;
}

export interface TouchEventView {
  id: string;
  at: string;
  kind: TouchKind;
  source: string;
  campaign: string | null;
  adset: string | null;
  ad: string | null;
  ad_id: string | null;
  ctwa_clid: string | null;
  headline: string | null;
  thumbnail_url: string | null;
  source_url: string | null;
  utm: Record<string, string>;
}

const MAX = { text: 200, adId: 100, clid: 500, headline: 300, ref: 200, url: 1000, utmKeys: 12, utmValue: 100 } as const;
const cut = (v: string | null | undefined, n: number): string | null => {
  const s = (v ?? '').replace(/\p{Cc}/gu, ' ').trim();
  return s === '' ? null : s.slice(0, n);
};
/** Solo direcciones https sin usuario ni contraseña: el resto no se guarda (la interfaz las abre en una pestaña nueva). */
export function cleanUrl(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  if (s.length === 0 || s.length > MAX.url) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.username && !u.password ? s : null;
  } catch {
    return null;
  }
}
const cleanUtm = (u: Record<string, string> | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(u ?? {}).slice(0, MAX.utmKeys)) {
    const key = k.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);
    const val = cut(v, MAX.utmValue);
    if (key && val) out[key] = val;
  }
  return out;
};

/**
 * Historial de toques de un contacto (M6.6, ADR-55 fase A): se escribe en la transacción de quien lo causa (el clic, el formulario, el primer mensaje) y solo se agrega. La lectura respeta
 * el alcance por persona: si el contacto no es visible para quien pregunta, 404 como en el resto del CRM.
 */
@Injectable()
export class ContactTouchesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ContactsService) private readonly contacts: ContactsService,
  ) {}

  /** Registra un toque (idempotente por `origin_ref`). Devuelve si se insertó. */
  async record(tx: TenantTx, contactId: string, e: TouchEventInput): Promise<boolean> {
    const rows = await tx
      .insert(contactTouchEvents)
      .values({
        contactId,
        occurredAt: e.at,
        kind: e.kind,
        source: e.source,
        campaign: cut(e.campaign, MAX.text),
        adset: cut(e.adset, MAX.text),
        ad: cut(e.ad, MAX.text),
        adId: cut(e.adId, MAX.adId),
        ctwaClid: cut(e.ctwaClid, MAX.clid),
        headline: cut(e.headline, MAX.headline),
        thumbnailUrl: cleanUrl(e.thumbnailUrl),
        sourceUrl: cleanUrl(e.sourceUrl),
        utm: cleanUtm(e.utm),
        originRef: cut(e.originRef, MAX.ref),
      })
      .onConflictDoNothing()
      .returning({ id: contactTouchEvents.id });
    return rows.length > 0;
  }

  /** El historial del contacto, del más reciente al más antiguo. */
  async list(scope: ContactScope, contactId: string): Promise<{ items: TouchEventView[] }> {
    await this.contacts.get(scope, contactId); // 404 si no es visible para la persona
    const rows = await this.db.withTenant((tx) =>
      tx.select().from(contactTouchEvents).where(and(eq(contactTouchEvents.contactId, contactId))).orderBy(desc(contactTouchEvents.occurredAt), asc(contactTouchEvents.id)).limit(200),
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        at: r.occurredAt.toISOString(),
        kind: r.kind as TouchKind,
        source: r.source,
        campaign: r.campaign,
        ad: r.ad,
        adset: r.adset,
        ad_id: r.adId,
        ctwa_clid: r.ctwaClid,
        headline: r.headline,
        thumbnail_url: r.thumbnailUrl,
        source_url: r.sourceUrl,
        utm: r.utm,
      })),
    };
  }
}
