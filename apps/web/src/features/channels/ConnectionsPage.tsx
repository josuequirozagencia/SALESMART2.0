import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import type { Channel } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill, type PillKind } from '../../ui/Pill';
import { SettingsNav } from '../app/SettingsNav';
import { useQueues } from '../queues/useQueues';
import { ChannelDialog } from './ChannelDialog';
import { QrSection } from './QrSection';
import { TemplatesDialog } from './TemplatesDialog';
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
        <div className="flex gap-1.5"><dt className="text-muted">Cola</dt><dd>{queueName ?? 'sin cola'}</dd></div>
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

/**
 * Configuración › Conexiones (M5.1, ADR-50). El administrador conecta cada número de WhatsApp oficial con los datos de Meta (WABA ID, Phone number ID y un token
 * permanente). El servidor comprueba el token antes de guardarlo, lo cifra y no lo devuelve jamás (solo los últimos 4 caracteres). Recibir y enviar mensajes
 * llega en las rebanadas siguientes de M5: esta pantalla solo deja listo el número.
 */
export function ConnectionsPage() {
  const q = useChannels();
  const queues = useQueues();
  const queueName = (id: string | null): string | null => (id ? (queues.data?.items.find((x) => x.id === id)?.name ?? null) : null);
  const [dialog, setDialog] = useState<{ channel?: Channel } | null>(null);
  const [templatesOf, setTemplatesOf] = useState<Channel | null>(null);
  const [error, setError] = useState<string>();
  const items = q.data?.items ?? [];
  const vaultOk = q.data?.vault.available !== false;

  return (
    <div className="grid gap-4">
      <SettingsNav />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[680px] text-[13.5px] text-muted">
          Conecta aquí cada número de WhatsApp oficial de tu empresa. Necesitas el ID de la cuenta, el ID del número y un token permanente que se generan en Meta (Meta Business › Usuarios del sistema).
        </p>
        {q.isSuccess ? <Button variant="primary" disabled={!vaultOk} onClick={() => setDialog({})}>Conectar un número</Button> : null}
      </div>

      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando conexiones" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'Solo el administrador de la empresa puede ver y cambiar las conexiones.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && !vaultOk ? <Alert kind="info">Por ahora no se pueden guardar conexiones: la plataforma aún no tiene configurado el cifrado de credenciales. Avisa a soporte.</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}

      {q.isSuccess ? (
        items.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line p-6 text-center text-[13.5px] text-muted">Aún no hay números conectados.{vaultOk ? ' Conecta el primero con «Conectar un número».' : ''}</p>
        ) : (
          <ul aria-label="Conexiones" className="grid gap-3">
            {items.map((c) => <ChannelCard key={c.id} channel={c} queueName={queueName(c.queue_id)} onEdit={() => setDialog({ channel: c })} onTemplates={() => setTemplatesOf(c)} onError={setError} />)}
          </ul>
        )
      ) : null}

      <QrSection />

      {templatesOf ? <TemplatesDialog channel={templatesOf} onClose={() => setTemplatesOf(null)} /> : null}
      {dialog ? <ChannelDialog {...(dialog.channel ? { channel: dialog.channel } : {})} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
