import type { ReactNode } from 'react';
import { DEFAULT_BRAND_NAME, useBrand } from '../lib/platformBrand';
import { CheckIcon } from './controls';

const POINTS = [
  'Inbox con WhatsApp, Messenger e Instagram',
  'Agentes de IA que atienden y califican por ti',
  'Pipelines, citas, ventas y comisiones',
  'Llamadas desde el navegador',
];

const initialOf = (name: string): string => name.trim().charAt(0).toUpperCase() || 'S';

/**
 * La marca de la plataforma (v11 §3): el logo que subió el Súper Admin para el fondo indicado (`dark` por omisión: la barra lateral y el panel de acceso son oscuros) o, sin él, el cuadrado con la inicial
 * y el nombre. Sin marca propia se ve como siempre («Sales Smart 2.0»).
 */
export function Logo({ surface = 'dark' }: { surface?: 'light' | 'dark' }) {
  const b = useBrand();
  const src = surface === 'dark' ? (b.logo.dark ?? b.logo.light) : (b.logo.light ?? b.logo.dark);
  if (src) return <img src={src} alt={b.name} className="h-9 w-auto max-w-[220px] object-contain" />;
  return (
    <div className="flex items-center gap-2.5 text-[17px] font-bold">
      <i className="grid size-[34px] place-items-center rounded-[10px] font-[inherit] not-italic text-[color:var(--on-grad)] [background:var(--grad)]">{initialOf(b.name)}</i>
      {b.name === DEFAULT_BRAND_NAME ? <>Sales Smart <span className="rounded-full bg-white/15 px-2 py-0.5 text-[10.5px] font-semibold">2.0</span></> : b.name}
    </div>
  );
}

/** El cuadrado de la marca (menú lateral plegado): el icono de la aplicación si el Súper Admin subió uno; si no, la inicial del nombre. */
export function BrandMark() {
  const b = useBrand();
  if (b.iconCustom && b.icon192) return <img src={b.icon192} alt={b.name} className="size-[34px] rounded-[10px] object-cover" />;
  return <i aria-label={b.name} role="img" className="grid size-[34px] place-items-center rounded-[10px] text-[17px] font-bold not-italic text-[color:var(--on-grad)] [background:var(--grad)]">{initialOf(b.name)}</i>;
}

/** Marco de las pantallas de acceso: panel de marca a la izquierda (se oculta en móvil) y la tarjeta a la derecha. */
export function AuthShell({ kind = 'login', children }: { kind?: 'login' | 'signup'; children: ReactNode }) {
  return (
    <div className="grid min-h-full grid-cols-1 min-[861px]:grid-cols-[minmax(380px,46%)_1fr]">
      <aside className="relative flex flex-col gap-[26px] overflow-hidden px-[22px] py-6 text-white min-[861px]:px-[46px] min-[861px]:py-[42px] [background:var(--side-bg)]">
        <span aria-hidden className="absolute -right-[190px] -top-[160px] size-[520px] rounded-full opacity-[.22] [background:var(--grad)]" />
        <span aria-hidden className="absolute -bottom-[110px] -left-[120px] size-[340px] rounded-full opacity-[.14] [background:var(--grad)]" />
        <div className="relative"><Logo /></div>
        <h2 className="relative max-w-[420px] text-[22px] font-bold leading-[1.15] tracking-[-.02em] min-[861px]:mt-auto min-[861px]:text-[30px]">
          {kind === 'signup' ? 'Empieza a vender más con cada conversación' : 'Todas tus conversaciones y ventas en un solo lugar'}
        </h2>
        <p className="relative max-w-[420px] text-[13px] text-white/70 min-[861px]:text-[14px]">CRM, Inbox omnicanal, WhatsApp, agentes de IA y llamadas, con equipo y comisiones.</p>
        <ul className="relative hidden gap-3 min-[861px]:grid">
          {POINTS.map((p) => (
            <li key={p} className="flex items-start gap-2.5 text-[13.5px] text-white/90">
              <CheckIcon className="mt-px size-[18px] flex-none rounded-full bg-white/15 p-[3px]" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
        <div className="relative mt-auto hidden rounded-[14px] border border-white/20 bg-white/10 px-4 py-3.5 text-[13px] min-[861px]:block">
          <b className="mb-0.5 block text-[15px]">Prueba gratis, con acceso a todo</b>
          Sin tarjeta. Si necesitas más tiempo, puedes pedir una extensión.
        </div>
      </aside>
      <main className="grid place-items-center px-[18px] py-[22px] min-[861px]:px-6 min-[861px]:py-[34px]">
        <div className="grid w-[min(430px,100%)] gap-3.5">{children}</div>
      </main>
    </div>
  );
}

export function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <>
      <h1 className="text-[25px] font-bold tracking-[-.02em]">{children}</h1>
      {sub ? <p className="-mt-1.5 text-[13.5px] text-muted">{sub}</p> : null}
    </>
  );
}
