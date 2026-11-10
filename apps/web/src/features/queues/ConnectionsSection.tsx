import { useMemo, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Queue } from '../../lib/types';
import { Alert, Button } from '../../ui/controls';
import { useChannels } from '../channels/useChannels';
import { useQrChannels } from '../channels/useQrChannels';
import { useQueues, useSetQueueConnections } from './useQueues';

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg';

/** Lo que de verdad hace el cambio (ADR-65): afecta a las conversaciones NUEVAS; las que ya existen siguen en el departamento que tenían. */
export const NEW_ONLY = 'Las conversaciones que ya existen siguen en el departamento que tenían.';

interface Conn {
  key: string;
  kind: 'channel' | 'qr';
  id: string;
  name: string;
  queueId: string | null;
}

const keyOf = (kind: 'channel' | 'qr', id: string): string => `${kind}:${id}`;
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * «Conexiones que usan este departamento» (v7 fase B, ADR-65): todas las conexiones de la empresa (oficiales y por QR) con su departamento actual y un interruptor «Usar en este departamento».
 * Una conexión que está en otro departamento se mueve aquí al guardar. Si al guardar quedan conexiones que SALEN de este departamento, se pide a cuál pasan (obligatorio) o se confirma dejarlas
 * sin departamento. Solo el administrador de conexiones ve la lista completa; sin ese permiso se muestra, de solo lectura, lo que ya usa el departamento.
 */
export function ConnectionsSection({ queue }: { queue: Queue }) {
  const official = useChannels();
  const qr = useQrChannels();
  const queues = useQueues();
  const save = useSetQueueConnections();
  const initial = useMemo(() => new Set(queue.channels.map((c) => keyOf(c.kind, c.id))), [queue.channels]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(initial);
  const [asking, setAsking] = useState(false);
  const [dest, setDest] = useState('');
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();

  const queueName = (id: string | null): string | null => (id ? (queues.data?.items.find((q) => q.id === id)?.name ?? null) : null);
  const all: Conn[] = [
    ...(official.data?.items ?? []).map((c): Conn => ({ key: keyOf('channel', c.id), kind: 'channel', id: c.id, name: c.name, queueId: c.queue_id })),
    ...(qr.data?.items ?? []).map((c): Conn => ({ key: keyOf('qr', c.id), kind: 'qr', id: c.id, name: c.name, queueId: c.queue_id })),
  ];
  const loading = official.isPending || qr.isPending;
  const denied = official.isError && qr.isError;
  const changed = !sameSet(picked, initial);
  const leaving = [...initial].filter((k) => !picked.has(k));
  const entering = all.filter((c) => picked.has(c.key) && !initial.has(c.key));
  const others = (queues.data?.items ?? []).filter((q) => q.id !== queue.id);
  const nameOf = (k: string): string => all.find((c) => c.key === k)?.name ?? queue.channels.find((c) => keyOf(c.kind, c.id) === k)?.name ?? 'la conexión';

  const toggle = (k: string): void => {
    setNote(undefined);
    setError(undefined);
    setAsking(false);
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const send = (move_removed_to: string | null, allow_unassigned: boolean): void => {
    setError(undefined);
    setNote(undefined);
    save.mutate(
      { id: queue.id, connections: [...picked].map((k) => ({ kind: k.startsWith('qr:') ? ('qr' as const) : ('channel' as const), id: k.slice(k.indexOf(':') + 1) })), move_removed_to, allow_unassigned },
      {
        onSuccess: (r) => {
          setPicked(new Set(r.channels.map((c) => keyOf(c.kind, c.id))));
          setAsking(false);
          setDest('');
          setNote('Conexiones guardadas.');
        },
        onError: (e) => setError(friendlyError(e, 'No pudimos guardar las conexiones.')),
      },
    );
  };

  const onSave = (): void => {
    if (leaving.length > 0) {
      setAsking(true);
      return;
    }
    send(null, false);
  };

  return (
    <section className="grid gap-2" aria-label="Conexiones del departamento">
      <span className="text-[12.5px] font-semibold">Conexiones que usan este departamento</span>
      {loading ? <p className="text-[12.5px] text-muted">Cargando conexiones…</p> : null}
      {denied ? (
        queue.channels.length === 0 ? <p className="text-[12.5px] text-muted">Ninguna todavía.</p> : <p className="text-[13px]">{queue.channels.map((c) => c.name).join(', ')}</p>
      ) : null}
      {!loading && !denied && all.length === 0 ? <p className="text-[12.5px] text-muted">Aún no hay conexiones. Crea una en Configuración › Conexiones.</p> : null}
      {!loading && !denied && all.length > 0 ? (
        <>
          <ul className="grid gap-2" aria-label="Conexiones de la empresa">
            {all.map((c) => {
              const on = picked.has(c.key);
              const elsewhere = c.queueId !== null && c.queueId !== queue.id;
              const where = queueName(c.queueId);
              return (
                <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3">
                  <span className="grid min-w-0 gap-0.5">
                    <span className="truncate text-[13.5px] font-semibold">{c.name} <span className="text-[11.5px] font-normal text-muted">{c.kind === 'qr' ? '· WhatsApp por QR · no oficial' : '· WhatsApp oficial'}</span></span>
                    <span className="text-[12px] text-muted">
                      {elsewhere && on && !initial.has(c.key) ? `Está en ${where ?? 'otro departamento'} · al usarla aquí se mueve` : elsewhere ? `Está en ${where ?? 'otro departamento'}` : c.queueId === queue.id ? 'Está en este departamento' : 'Sin departamento'}
                    </span>
                  </span>
                  <label className="inline-flex min-h-11 items-center gap-2 text-[13px] font-semibold">
                    <input type="checkbox" role="switch" checked={on} onChange={() => toggle(c.key)} aria-label={`Usar «${c.name}» en este departamento`} className="size-5 accent-[var(--accent)]" />
                    Usar en este departamento
                  </label>
                </li>
              );
            })}
          </ul>
          {picked.size === 0 ? <p className="text-[12.5px] text-muted">Ninguna todavía. Activa una conexión arriba.</p> : null}

          {asking ? (
            <div role="group" aria-label="Destino de las conexiones que quitas" className="grid gap-2 rounded-xl border border-warn bg-warn-soft p-3">
              <p className="text-[13px] font-semibold">¿A qué departamento pasan {leaving.length === 1 ? `«${nameOf(leaving[0]!)}»` : `las ${leaving.length} conexiones que quitas`}?</p>
              <label className="grid gap-1 text-[13px] font-semibold">
                Departamento de destino
                <select className={selectCls} value={dest} onChange={(e) => setDest(e.target.value)}>
                  <option value="">Elige un departamento…</option>
                  {others.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
                  <option value="__none">Dejarlas sin departamento</option>
                </select>
              </label>
              {dest === '' ? null : (
                <p className="text-[12.5px]">
                  {dest === '__none'
                    ? `Las conversaciones nuevas de ${leaving.map(nameOf).join(', ')} quedarán sin asignar y no se repartirán solas. ${NEW_ONLY}`
                    : `Las conversaciones nuevas de ${leaving.map(nameOf).join(', ')} irán a ${queueName(dest) ?? 'ese departamento'}. ${NEW_ONLY}`}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" disabled={dest === ''} loading={save.isPending} onClick={() => send(dest === '__none' ? null : dest, dest === '__none')}>Confirmar y guardar</Button>
                <Button onClick={() => setAsking(false)}>Cancelar</Button>
              </div>
            </div>
          ) : (
            <>
              {changed && entering.length > 0 ? <p className="text-[12.5px] text-muted">Las conversaciones nuevas de {entering.map((c) => c.name).join(', ')} irán a este departamento. {NEW_ONLY}</p> : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" disabled={!changed} loading={save.isPending} onClick={onSave}>Guardar conexiones</Button>
                {changed ? <Button onClick={() => { setPicked(initial); setNote(undefined); setError(undefined); }}>Descartar cambios</Button> : null}
              </div>
            </>
          )}
        </>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
      {note ? <Alert kind="ok">{note}</Alert> : null}
    </section>
  );
}
