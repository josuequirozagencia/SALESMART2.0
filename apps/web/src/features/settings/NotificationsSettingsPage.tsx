import { useState } from 'react';
import { playIncomingSound, soundReady, useSoundPref } from '../../lib/notifySound';
import { Button } from '../../ui/controls';
import { SettingsNav } from '../app/SettingsNav';

/**
 * Configuración › Notificaciones (v6 fase E). Por ahora solo el sonido de mensaje nuevo: es una preferencia de este navegador, por persona y empresa, activada por omisión. Las notificaciones
 * push del navegador no están: necesitan claves del servicio de push y una tabla de suscripciones, y se construyen cuando se aprueben (ver el informe de la fase).
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
      <section aria-label="Notificaciones del navegador" className="grid gap-1 rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-bold">Notificaciones del navegador</h2>
        <p className="text-[12.5px] text-muted">Aún no disponibles. Para avisarte con la pestaña cerrada hace falta configurar el servicio de notificaciones push; mientras tanto, el sonido y la campana «Avisos» te mantienen al tanto.</p>
      </section>
    </div>
  );
}
