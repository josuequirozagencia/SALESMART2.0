import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { shortDate } from '../../lib/format';
import type { ProviderItem, ProviderMaturity, ProviderService } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill, type PillKind } from '../../ui/Pill';
import { ProviderCredentialsDialog } from './ProviderCredentialsDialog';
import { useProviders, useSetActiveProvider } from './useProviders';

const MATURITY: Record<ProviderMaturity, [PillKind, string]> = {
  planned: ['ok', 'Previsto'],
  reserved: ['warn', 'Con reservas'],
  candidate: ['info', 'Candidato (PoC)'],
};

/** Modo actual de los servicios que se configuran con variables de entorno del servidor. */
const MODE: Record<string, Record<string, [PillKind, string]>> = {
  mail: { none: ['warn', 'Sin proveedor: los correos no salen'], console: ['info', 'Consola (solo desarrollo)'], memory: ['info', 'Memoria (solo pruebas)'], resend: ['ok', 'Resend activo'] },
  captcha: { none: ['warn', 'Sin anti-bots: el registro responde 503'], fake: ['info', 'Falso (solo desarrollo)'], turnstile: ['ok', 'Turnstile activo'] },
};

function ProviderRow({ s, p, vault, onConfigure, onToggle, busy }: { s: ProviderService; p: ProviderItem; vault: boolean; onConfigure: (p: ProviderItem) => void; onToggle: (p: ProviderItem, on: boolean) => void; busy: boolean }) {
  const [kind, label] = MATURITY[p.maturity];
  const active = s.active === p.key;
  return (
    <li className="grid gap-2 rounded-xl border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          <b className="block truncate text-[13.5px]">{p.label}</b>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <Pill kind={kind}>{label}</Pill>
            {p.fields.length > 0 ? (p.configured ? <Pill kind="ok">Con credenciales</Pill> : <Pill kind="muted">Faltan datos</Pill>) : null}
            {active ? <Pill kind="accent">En uso</Pill> : null}
          </span>
        </span>
        <span className="flex flex-wrap gap-2">
          <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Configurar ${p.label}`} onClick={() => onConfigure(p)}>Configurar</Button>
          {active ? (
            <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Dejar de usar ${p.label}`} loading={busy} onClick={() => onToggle(p, false)}>Dejar de usar</Button>
          ) : (
            <Button variant="primary" className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Usar ${p.label}`} disabled={!p.configured} loading={busy} onClick={() => onToggle(p, true)}>Usar</Button>
          )}
        </span>
      </div>
      {p.note ? <span className="text-[12px] text-muted">{p.note}</span> : null}
      {p.updated_at ? <span className="text-[11.5px] text-muted">Última actualización: {shortDate(p.updated_at)}{!vault && p.fields.length > 0 ? ' · sin clave de cifrado en el servidor' : ''}</span> : null}
    </li>
  );
}

function ServiceCard({ s, vault, onConfigure, onToggle, busyKey }: { s: ProviderService; vault: boolean; onConfigure: (s: ProviderService, p: ProviderItem) => void; onToggle: (s: ProviderService, p: ProviderItem, on: boolean) => void; busyKey: string | undefined }) {
  const activeLabel = s.providers.find((p) => p.key === s.active)?.label;
  const envMode = s.mode ? MODE[s.key]?.[s.mode] : undefined;
  return (
    <section aria-label={s.label} className="grid content-start gap-2 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-bold">{s.label}</h3>
        {s.managed === 'platform' ? (activeLabel ? <Pill kind="ok">En uso: {activeLabel}</Pill> : <Pill kind="muted">Sin proveedor en uso</Pill>) : null}
        {s.managed === 'env' && envMode ? <Pill kind={envMode[0]}>{envMode[1]}</Pill> : null}
        {s.managed === 'fixed' ? <Pill kind="muted">Fijo</Pill> : null}
        {s.managed === 'client' ? <Pill kind="muted">Por empresa</Pill> : null}
      </div>
      <span className="font-mono text-[11.5px] text-muted">{s.adapter}</span>
      <p className="text-[12.5px] text-muted">{s.note}</p>
      {s.managed === 'platform' ? (
        s.providers.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-3 text-center text-[12.5px] text-muted">Todavía no hay candidatos.</p>
        ) : (
          <ul className="grid gap-2" aria-label={`Proveedores de ${s.label}`}>
            {s.providers.map((p) => <ProviderRow key={p.key} s={s} p={p} vault={vault} onConfigure={(x) => onConfigure(s, x)} onToggle={(x, on) => onToggle(s, x, on)} busy={busyKey === `${s.key}/${p.key}`} />)}
          </ul>
        )
      ) : (
        <ul className="grid gap-1 text-[12.5px]" aria-label={`Proveedor de ${s.label}`}>{s.providers.map((p) => <li key={p.key} className="flex items-center gap-2"><b>{p.label}</b><Pill kind={MATURITY[p.maturity][0]}>{MATURITY[p.maturity][1]}</Pill></li>)}</ul>
      )}
    </section>
  );
}

/**
 * «Proveedores» (ADR-21/ADR-42): qué empresa externa está detrás de cada servicio y con qué credenciales. SOLO el Súper Admin lo ve y lo cambia:
 * las agencias y los clientes usan sus conexiones sin ver ni tocar los proveedores. Todo lo que guardas es de escritura: nunca se vuelve a mostrar, solo cómo termina.
 */
export function ProvidersPage() {
  const q = useProviders();
  const setActive = useSetActiveProvider();
  const [editing, setEditing] = useState<{ service: ProviderService; provider: ProviderItem }>();
  const [error, setError] = useState<string>();
  const [busyKey, setBusyKey] = useState<string>();

  function toggle(s: ProviderService, p: ProviderItem, on: boolean) {
    setError(undefined);
    setBusyKey(`${s.key}/${p.key}`);
    setActive.mutate({ service: s.key, provider: on ? p.key : null }, { onError: (e) => setError(friendlyError(e, 'No pudimos cambiar el proveedor en uso.')), onSettled: () => setBusyKey(undefined) });
  }

  // El diálogo trabaja con los datos más recientes del servidor (se refrescan al guardar)
  const current = editing ? q.data?.services.find((s) => s.key === editing.service.key) : undefined;
  const currentProvider = current?.providers.find((p) => p.key === editing?.provider.key);

  return (
    <div className="grid gap-4">
      <p className="text-[13px] text-muted">Qué empresa externa está detrás de cada servicio y con qué credenciales. Solo tú lo ves y lo cambias: las agencias y los clientes usan sus conexiones sin ver ni tocar los proveedores.</p>
      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando proveedores" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los proveedores.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && !q.data.vault.available ? <Alert kind="info">Falta la clave de cifrado en el servidor (PROVIDER_CREDENTIALS_KEY): todavía no se pueden guardar credenciales (claves de API, tokens, URL de instancias…). Elegir el proveedor en uso sí funciona.</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      {q.isSuccess ? (
        <div className="grid gap-3 min-[900px]:grid-cols-2">
          {q.data.services.map((s) => <ServiceCard key={s.key} s={s} vault={q.data.vault.available} onConfigure={(service, provider) => setEditing({ service, provider })} onToggle={toggle} busyKey={busyKey} />)}
        </div>
      ) : null}
      {editing && current && currentProvider && q.data ? <ProviderCredentialsDialog key={`${current.key}/${currentProvider.key}`} service={current} provider={currentProvider} active={current.active === currentProvider.key} vaultAvailable={q.data.vault.available} onClose={() => setEditing(undefined)} /> : null}
    </div>
  );
}
