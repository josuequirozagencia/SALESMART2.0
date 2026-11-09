import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { currentSubscription, disablePush, enablePush, fetchPushConfig, fetchPushStatus, notificationPermission, pushSupport, updateShowText } from '../../lib/push';
import { playIncomingSound, soundReady, useSoundPref } from '../../lib/notifySound';
import { Alert, Button } from '../../ui/controls';
import { SettingsNav } from '../app/SettingsNav';

/** Notificaciones del navegador (push): estado de este navegador y activar/desactivar. */
function PushCard() {
  const qc = useQueryClient();
  const support = pushSupport();
  const cfg = useQuery({ queryKey: ['push-config'], retry: false, staleTime: 60_000, queryFn: fetchPushConfig });
  const mine = useQuery({
    queryKey: ['push-status'],
    enabled: support === 'ok' && cfg.data?.enabled === true,
    retry: false,
    queryFn: async () => {
      const sub = await currentSubscription();
      return sub ? fetchPushStatus(sub.endpoint) : { subscribed: false, show_text: false };
    },
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (fn: () => Promise<unknown>, fallback: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['push-status'] });
    } catch (e) {
      setError(e instanceof Error && !('status' in e) ? e.message : friendlyError(e, fallback));
    } finally {
      setBusy(false);
    }
  };
  const subscribed = mine.data?.subscribed === true;
  const permission = notificationPermission();
  return (
    <section aria-label="Notificaciones del navegador" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
      <div>
        <h2 className="text-[15px] font-bold">Notificaciones del navegador</h2>
        <p className="text-[12.5px] text-muted">Te avisan de un mensaje nuevo aunque tengas la pestaña cerrada o en segundo plano. Se activan por navegador y solo cuando tú lo pides.</p>
      </div>
      {cfg.isPending ? <p className="text-[12.5px] text-muted">Revisando…</p> : null}
      {cfg.isError ? <Alert>{friendlyError(cfg.error, 'No pudimos revisar si las notificaciones están disponibles.')}</Alert> : null}
      {cfg.data && !cfg.data.enabled ? <p role="status" className="text-[12.5px] text-muted">Las notificaciones push no están activadas en este servidor. El sonido y la campana «Avisos» te mantienen al tanto.</p> : null}
      {cfg.data?.enabled && support === 'insecure' ? <p role="status" className="text-[12.5px] text-muted">Las notificaciones solo funcionan en una conexión segura (HTTPS).</p> : null}
      {cfg.data?.enabled && support === 'unsupported' ? <p role="status" className="text-[12.5px] text-muted">Este navegador no admite notificaciones push. En iPhone y iPad hay que añadir la aplicación a la pantalla de inicio (Compartir › Añadir a pantalla de inicio) y abrirla desde ahí.</p> : null}
      {cfg.data?.enabled && support === 'ok' ? (
        <>
          <p role="status" className="text-[13px] font-semibold">
            {subscribed ? 'Activadas en este navegador.' : permission === 'denied' ? 'Bloqueadas por el navegador.' : 'Desactivadas en este navegador.'}
          </p>
          {permission === 'denied' && !subscribed ? <p className="text-[12.5px] text-muted">Para activarlas, permite las notificaciones de este sitio desde el candado de la barra de direcciones y vuelve aquí.</p> : null}
          {subscribed ? (
            <label className="flex min-h-11 items-start gap-3 text-[13px]">
              <input type="checkbox" role="switch" checked={mine.data?.show_text === true} disabled={busy} onChange={(e) => void run(() => updateShowText(e.target.checked), 'No pudimos guardar el cambio.')} className="mt-0.5 size-5 accent-[var(--accent)]" />
              <span><b className="font-semibold">Mostrar el texto del mensaje</b><span className="block text-[12px] text-muted">Si lo apagas, la notificación dice solo «Mensaje nuevo» (más privado en una pantalla bloqueada o compartida).</span></span>
            </label>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            {subscribed ? (
              <Button loading={busy} onClick={() => void run(disablePush, 'No pudimos desactivar las notificaciones.')}>Desactivar en este navegador</Button>
            ) : (
              <Button variant="primary" loading={busy} disabled={permission === 'denied'} onClick={() => void run(() => enablePush(cfg.data?.public_key ?? '', false), 'No pudimos activar las notificaciones.')}>Activar notificaciones</Button>
            )}
          </div>
          {error ? <Alert>{error}</Alert> : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * Configuración › Notificaciones (v6 fase E). El sonido de mensaje nuevo es una preferencia de este navegador, por persona y empresa, activada por omisión. Las notificaciones push (con la pestaña
 * cerrada) se activan aquí, por navegador: solo entonces se pide el permiso. La suscripción vive en el servidor (por persona y empresa) y se puede dar de baja en cualquier momento.
 */
export function NotificationsSettingsPage() {
  const sound = useSoundPref();
  const [note, setNote] = useState<string>();
  return (
    <div className="grid gap-4">
      <SettingsNav />
      <section aria-label="Sonido" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
        <div>
          <h2 className="text-[15px] font-bold">Sonido de mensaje nuevo</h2>
          <p className="text-[12.5px] text-muted">Suena cuando llega un mensaje de un cliente. No suena por tus propios mensajes ni por notas internas, ni cuando ya tienes esa conversación abierta a la vista. Se recuerda en este navegador.</p>
        </div>
        <label className="flex min-h-11 items-center gap-3 text-[13.5px] font-semibold">
          <input type="checkbox" role="switch" checked={sound.enabled} onChange={(e) => sound.set(e.target.checked)} className="size-5 accent-[var(--accent)]" />
          Sonido de mensaje nuevo
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => setNote(playIncomingSound() ? undefined : soundReady() ? 'No se pudo reproducir el sonido en este navegador.' : 'El navegador aún no permite sonar: toca la página una vez e inténtalo de nuevo.')}>Probar el sonido</Button>
          {note ? <span role="status" className="text-[12.5px] text-muted">{note}</span> : null}
        </div>
        <p className="text-[12px] text-muted">En un teléfono o con el navegador en segundo plano, algunos sistemas silencian las páginas: el aviso sonoro funciona con la aplicación abierta.</p>
      </section>
      <PushCard />
    </div>
  );
}
