import { ContextBanner } from '../features/context/ContextBanner';
import { TrialBanner } from '../features/trial/TrialBanner';
import { ROLE_LABEL } from '../lib/format';
import type { Me, Trial } from '../lib/types';
import { Button } from '../ui/controls';
import { Logo } from '../ui/AuthShell';

/**
 * Pantalla inicial tras iniciar sesión. Aún NO hay módulos de negocio (llegan en M3 en adelante): solo confirma la
 * organización y el rol de la sesión y muestra el estado de la prueba. El menú real sale del prototipo en hitos posteriores.
 */
export function HomeScreen({ me, trial, onLogout }: { me: Me; trial: Trial | null; onLogout: () => void }) {
  const platform = me.organization.kind === 'platform';
  return (
    <div className="min-h-full bg-bg">
      <ContextBanner me={me} />
      <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-5 py-3">
        <span className="text-fg [&_i]:text-[color:var(--on-grad)]"><Logo /></span>
        <div className="flex items-center gap-3 text-[13px]">
          <span className="hidden text-right min-[560px]:block">
            <b className="block">{me.organization.name}</b>
            <span className="text-muted">{me.user.full_name ?? me.user.email} · {ROLE_LABEL[me.role] ?? me.role}</span>
          </span>
          <Button onClick={onLogout}>Cerrar sesión</Button>
        </div>
      </header>
      <main className="mx-auto grid max-w-[880px] gap-4 p-5">
        {trial ? <TrialBanner trial={trial} role={me.role} /> : null}
        <section className="rounded-2xl border border-line bg-surface p-6">
          <h1 className="text-[22px] font-bold">{platform ? 'Consola de plataforma' : `Hola, ${me.organization.name}`}</h1>
          <p className="mt-1.5 text-[13.5px] text-muted">
            {platform
              ? 'Tu sesión está activa. La consola (empresas, agencias, pruebas y accesos) llega en el hito M2.'
              : 'Tu cuenta está lista. Inbox, contactos, pipelines y el resto de los módulos llegan en los siguientes hitos.'}
          </p>
        </section>
      </main>
    </div>
  );
}
