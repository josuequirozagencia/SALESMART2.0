import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import type { Channel } from '../../lib/types';
import { Alert, Button, Input, Spinner } from '../../ui/controls';
import { Link } from 'react-router-dom';
import { Pill, type PillKind } from '../../ui/Pill';
import { SettingsNav } from '../app/SettingsNav';
import { useGhlConnection } from '../ghl/useGhl';
import { useMetaSettings } from '../meta/useMeta';
import { useQueues } from '../queues/useQueues';
import { ChannelDialog } from './ChannelDialog';
import { ConnectionCard, type ConnectionStatus } from './ConnectionCard';
import { QrSection } from './QrSection';
import { TemplatesDialog } from './TemplatesDialog';
import { useQrChannels } from './useQrChannels';
import { useCheckChannel, useChannels, useDisconnectChannel, useUpdateChannel } from './useChannels';

const SMALL = '!px-3 !py-1.5 !text-[12.5px]';

function statusPill(c: Channel): { kind: PillKind; label: string } {
  if (c.status === 'disabled') return { kind: 'muted', label: 'Desactivada' };
  if (c.last_error) return { kind: 'crit', label: 'Requiere atención' };
  return { kind: 'ok', label: 'Activa' };
}

function ChannelCard({ channel: c, queueName, onEdit, onTemplates, onError }: { channel: Channel; queueName: string | null; onEdit: () => void; onTemplates: () => void; onError: (m: string | undefined) => void }) {
  const check = useCheckChannel();
  const update = useUpdateChannel();
  const disconnect = useDisconnectChannel();
  const [confirm, setConfirm] = useState(false);
  const pill = statusPill(c);
  const fail = (fallback: string) => (e: unknown) => { setConfirm(false); onError(friendlyError(e, fallback)); };

  return (
    <li aria-label={c.name} className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <span className="text-[15px] font-bold">{c.name}</span>
          <span className="text-[13px] text-muted">WhatsApp oficial · {c.display_phone ?? 'Número sin confirmar'}{c.verified_name ? ` · ${c.verified_name}` : ''}</span>
        </div>
        <Pill kind={pill.kind}>{pill.label}</Pill>
      </div>
      {c.last_error ? <Alert>{c.last_error}</Alert> : null}
      <dl className="grid gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-2">
        <div className="flex gap-1.5"><dt className="text-muted">WABA ID</dt><dd className="font-mono">{c.waba_id}</dd></div>
        <div className="flex gap-1.5"><dt className="text-muted">Phone number ID</dt><dd className="font-mono">{c.phone_number_id}</dd></div>
        <div className="flex gap-1.5"><dt className="text-muted">Token</dt><dd className="font-mono">{c.token_last4 ? `••••${c.token_last4}` : 'sin token'}</dd></div>
        <div className="flex gap-1.5"><dt className="text-muted">Última comprobación</dt><dd>{c.last_check_at ? shortDateTime(c.last_check_at) : 'nunca'}</dd></div>
        <div className="flex gap-1.5"><dt className="text-muted">Departamento</dt><dd>{queueName ?? 'sin departamento'}</dd></div>
        <div className="flex gap-1.5"><dt className="text-muted">Último aviso de Meta</dt><dd>{c.last_event_at ? shortDateTime(c.last_event_at) : 'ninguno todavía'}</dd></div>
      </dl>
      {confirm ? (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span>¿Desconectar «{c.name}»? Se borra el token guardado y el número queda libre.</span>
          <Button variant="danger" className={SMALL} loading={disconnect.isPending} onClick={() => { onError(undefined); disconnect.mutate(c.id, { onError: fail('No pudimos desconectar el número.') }); }}>Sí, desconectar</Button>
          <Button className={SMALL} onClick={() => setConfirm(false)}>No</Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button className={SMALL} aria-label={`Comprobar ${c.name}`} loading={check.isPending} onClick={() => { onError(undefined); check.mutate(c.id, { onError: fail('No pudimos comprobar la conexión.') }); }}>Comprobar</Button>
          <Button className={SMALL} aria-label={`Editar ${c.name}`} onClick={onEdit}>Editar</Button>
          <Button className={SMALL} aria-label={`Plantillas de ${c.name}`} onClick={onTemplates}>Plantillas</Button>
          <Button className={SMALL} aria-label={`${c.status === 'active' ? 'Desactivar' : 'Activar'} ${c.name}`} loading={update.isPending} onClick={() => { onError(undefined); update.mutate({ id: c.id, input: { status: c.status === 'active' ? 'disabled' : 'active' } }, { onError: fail('No pudimos cambiar el estado.') }); }}>{c.status === 'active' ? 'Desactivar' : 'Activar'}</Button>
          <Button className={SMALL} aria-label={`Desconectar ${c.name}`} onClick={() => setConfirm(true)}>Desconectar</Button>
        </div>
      )}
    </li>
  );
}

/** El aviso del canal NO OFICIAL que va SIEMPRE en su tarjeta (no se puede quitar ni acortar). */
export const QR_CARD_WARNING = 'No es la API oficial de WhatsApp. WhatsApp puede bloquear o suspender el número, la sesión puede desconectarse y no hay plantillas aprobadas. No lo uses con tu número principal.';

const linkBtn = 'inline-flex items-center justify-center rounded-[10px] border border-line px-3 py-1.5 text-[12.5px] font-semibold hover:bg-surface2';

/**
 * Configuración › Conexiones (M5.1 → M5.9, ADR-50). Galería de tarjetas en dos grupos: CANALES (por dónde hablan tus clientes: cada número de WhatsApp oficial es una tarjeta,
 * WhatsApp por QR —no oficial, con su aviso siempre a la vista—, y Messenger, Instagram y TikTok como «Próximamente») e INTEGRACIONES (GoHighLevel, API de Conversiones de Meta y
 * Calendario de Google «Próximamente»). Cada tarjeta dice si está Conectada, Requiere atención, No conectada o Próximamente; el buscador filtra por nombre. El administrador conecta
 * cada número con los datos de Meta; el servidor comprueba el token antes de guardarlo, lo cifra y no lo devuelve jamás (solo los últimos 4 caracteres).
 */
export function ConnectionsPage() {
  const q = useChannels();
  const queues = useQueues();
  const qr = useQrChannels();
  const ghl = useGhlConnection();
  const meta = useMetaSettings();
  const queueName = (id: string | null): string | null => (id ? (queues.data?.items.find((x) => x.id === id)?.name ?? null) : null);
  const [dialog, setDialog] = useState<{ channel?: Channel } | null>(null);
  const [templatesOf, setTemplatesOf] = useState<Channel | null>(null);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const items = q.data?.items ?? [];
  const vaultOk = q.data?.vault.available !== false;
  const term = search.trim().toLowerCase();
  const match = (...words: Array<string | null | undefined>): boolean => term === '' || words.some((w) => (w ?? '').toLowerCase().includes(term));

  const qrItems = qr.data?.items ?? [];
  const qrStatus: ConnectionStatus = qrItems.some((c) => c.state === 'closed' || c.state === 'logged_out' || c.last_error) ? 'attention' : qrItems.some((c) => c.state === 'open') ? 'connected' : 'disconnected';
  const ghlStatus: ConnectionStatus = ghl.data?.status === 'needs_reconnect' || ghl.data?.last_error ? 'attention' : ghl.data?.configured && ghl.data.status === 'active' ? 'connected' : 'disconnected';
  const metaStatus: ConnectionStatus = meta.data?.last_error ? 'attention' : meta.data?.configured && meta.data.enabled ? 'connected' : 'disconnected';

  const shownNumbers = items.filter((c) => match(c.name, c.display_phone, c.verified_name, 'whatsapp oficial'));
  const showOfficialCard = match('whatsapp oficial', 'whatsapp', 'meta');
  const showQr = match('whatsapp por qr', 'whatsapp', 'qr', 'no oficial');
  const soonChannels = [
    ['Messenger', 'Conversaciones de tu página de Facebook en el Inbox.'],
    ['Instagram', 'Mensajes directos de tu cuenta de Instagram en el Inbox.'],
    ['TikTok', 'Mensajes y leads de TikTok.'],
  ].filter(([n]) => match(n));
  const showGhl = match('gohighlevel', 'ghl', 'highlevel');
  const showMeta = match('api de conversiones de meta', 'meta', 'conversiones', 'capi', 'pixel');
  const showCalendar = match('calendario de google', 'google', 'calendario', 'agenda');
  const noChannels = shownNumbers.length === 0 && !showOfficialCard && !showQr && soonChannels.length === 0;
  const noIntegrations = !showGhl && !showMeta && !showCalendar;

  return (
    <div className="grid gap-5">
      <SettingsNav />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-[680px] text-[13.5px] text-muted">
          Conecta los canales por donde te escriben tus clientes y las integraciones con otras plataformas. Para WhatsApp oficial necesitas el ID de la cuenta, el ID del número y un token permanente que se generan en Meta (Meta Business › Usuarios del sistema).
        </p>
        <div className="w-full sm:w-[260px]"><Input aria-label="Buscar conexiones" type="search" placeholder="Buscar canal o integración" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      </div>

      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando conexiones" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'Solo el administrador de la empresa puede ver y cambiar las conexiones.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && !vaultOk ? <Alert kind="info">Por ahora no se pueden guardar conexiones: la plataforma aún no tiene configurado el cifrado de credenciales. Avisa a soporte.</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}

      {q.isSuccess ? (
        <>
          <section aria-label="Canales" className="grid gap-3">
            <h2 className="text-[13px] font-bold uppercase tracking-wide text-muted">Canales</h2>
            {noChannels ? <p className="text-[13.5px] text-muted">Ningún canal coincide con «{search.trim()}».</p> : (
              <ul aria-label="Conexiones" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {shownNumbers.map((c) => <ChannelCard key={c.id} channel={c} queueName={queueName(c.queue_id)} onEdit={() => setDialog({ channel: c })} onTemplates={() => setTemplatesOf(c)} onError={setError} />)}
                {showOfficialCard ? (
                  <ConnectionCard name="WhatsApp oficial" description="API oficial de Meta: plantillas aprobadas y sin riesgo de bloqueo." status={items.length > 0 ? 'connected' : 'disconnected'} note={items.length === 0 ? <span className="text-muted">Aún no hay números conectados.{vaultOk ? ' Conecta el primero con «Conectar un número».' : ''}</span> : <span className="text-muted">{items.length} {items.length === 1 ? 'número conectado' : 'números conectados'}.</span>}>
                    <Button variant="primary" className={SMALL} disabled={!vaultOk} onClick={() => setDialog({})}>Conectar un número</Button>
                  </ConnectionCard>
                ) : null}
                {showQr ? (
                  <ConnectionCard name="WhatsApp por QR" badge="No oficial" description="Vincula un número escaneando un QR, sin la API de Meta." status={qr.isSuccess ? qrStatus : 'disconnected'} note={<span className="font-medium text-warn">{QR_CARD_WARNING}</span>}>
                    <Button className={SMALL} aria-label="Administrar WhatsApp por QR" onClick={() => document.getElementById('whatsapp-qr')?.scrollIntoView?.({ behavior: 'smooth' })}>Administrar</Button>
                  </ConnectionCard>
                ) : null}
                {soonChannels.map(([n, d]) => <ConnectionCard key={n} name={n!} description={d!} status="soon" />)}
              </ul>
            )}
          </section>

          <section aria-label="Integraciones" className="grid gap-3">
            <h2 className="text-[13px] font-bold uppercase tracking-wide text-muted">Integraciones</h2>
            {noIntegrations ? <p className="text-[13.5px] text-muted">Ninguna integración coincide con «{search.trim()}».</p> : (
              <ul aria-label="Lista de integraciones" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {showGhl ? (
                  <ConnectionCard name="GoHighLevel" description="Contactos, etiquetas, mensajes e inscripción a flujos." status={ghl.isSuccess ? ghlStatus : 'disconnected'} note={ghl.data?.last_error ? <span className="text-crit">{ghl.data.last_error}</span> : undefined}>
                    <Link to="/settings/ghl" aria-label="Configurar GoHighLevel" className={linkBtn}>Configurar</Link>
                  </ConnectionCard>
                ) : null}
                {showMeta ? (
                  <ConnectionCard name="API de Conversiones de Meta" description="Envía a Meta los eventos Lead, Schedule y Purchase de tus anuncios." status={meta.isSuccess ? metaStatus : 'disconnected'} note={meta.data?.last_error ? <span className="text-crit">{meta.data.last_error}</span> : undefined}>
                    <Link to="/settings/meta" aria-label="Configurar la API de Conversiones" className={linkBtn}>Configurar</Link>
                  </ConnectionCard>
                ) : null}
                {showCalendar ? <ConnectionCard name="Calendario de Google" description="Sincroniza tus citas con Google Calendar." status="soon" /> : null}
              </ul>
            )}
          </section>

          {showQr ? <div id="whatsapp-qr"><QrSection /></div> : null}
        </>
      ) : null}

      {templatesOf ? <TemplatesDialog channel={templatesOf} onClose={() => setTemplatesOf(null)} /> : null}
      {dialog ? <ChannelDialog {...(dialog.channel ? { channel: dialog.channel } : {})} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
