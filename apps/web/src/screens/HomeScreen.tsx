import type { Me } from '../lib/types';

/**
 * Inicio de una empresa cliente. Aún NO hay tablero (llega con Analítica): confirma la organización y apunta a lo que ya existe.
 * El marco (cabecera, banners, secciones) lo pone `AppShell`.
 */
export function HomeScreen({ me }: { me: Me }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-6">
      <h1 className="text-[22px] font-bold">Hola, {me.organization.name}</h1>
      <p className="mt-1.5 text-[13.5px] text-muted">Tu cuenta está lista. Ya puedes cargar y buscar tus contactos; Inbox, pipelines y el resto de los módulos llegan en los siguientes hitos.</p>
    </section>
  );
}
