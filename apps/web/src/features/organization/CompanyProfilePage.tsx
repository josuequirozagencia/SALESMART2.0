import { useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { countryOptions, timezones } from '../../lib/countries';
import { friendlyError } from '../../lib/errors';
import { normalizePhone } from '../../lib/phone';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { SettingsNav } from '../app/SettingsNav';
import { useCompanyProfile, useSaveCompanyProfile, type CompanyProfile, type ProfilePatch } from './useCompanyProfile';

const selectCls = 'w-full rounded-[11px] border border-line-strong bg-surface px-3 py-[11px] text-[14px] font-normal text-fg disabled:opacity-60';
const card = 'grid gap-3 rounded-2xl border border-line bg-surface p-4';

/** Qué cambia (y qué no) al mover la zona horaria: lo dice la confirmación. */
export const ZONE_EFFECTS = [
  'Desde ahora usan la zona nueva: el horario laboral y los feriados, los horarios de cada persona, el tope diario de reparto, los periodos de Analítica y cómo se muestran las fechas.',
  'No se mueven los recordatorios de citas ya creados, los cronómetros de respuesta abiertos ni los mensajes y campañas ya programados.',
];

type Errors = Partial<Record<string, string>>;

/** Guardado de un bloque: errores por campo (los del servidor) y el aviso «Guardado». */
function useBlock() {
  const save = useSaveCompanyProfile();
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const run = (patch: ProfilePatch): void => {
    setErrors({});
    setError(undefined);
    setSaved(false);
    if (Object.keys(patch).length === 0) return setSaved(true);
    save.mutate(patch, {
      onSuccess: () => setSaved(true),
      onError: (e) => {
        if (e instanceof ApiError && e.code === 'VALIDATION_ERROR') setErrors(Object.fromEntries(e.details.map((d) => [d.path, d.message])));
        setError(friendlyError(e, 'No pudimos guardar los cambios.'));
      },
    });
  };
  const touch = (): void => setSaved(false);
  return { run, touch, errors, setErrors, error, saved, busy: save.isPending };
}

function Footer({ edit, block }: { edit: boolean; block: ReturnType<typeof useBlock> }) {
  return (
    <>
      {block.error ? <Alert>{block.error}</Alert> : null}
      {edit ? (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span role="status" aria-live="polite" className="text-[13px] font-semibold text-ok">{block.saved ? 'Guardado' : ''}</span>
          <Button type="submit" variant="primary" loading={block.busy}>Guardar</Button>
        </div>
      ) : null}
    </>
  );
}

function Identity({ p }: { p: CompanyProfile }) {
  const block = useBlock();
  const [name, setName] = useState(p.name);
  const edit = p.access.edit;
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const n = name.trim();
    if (n.length < 2) return block.setErrors({ name: 'Usa al menos 2 caracteres' });
    block.run(n === p.name ? {} : { name: n });
  };
  return (
    <form aria-label="Identidad" onSubmit={submit} noValidate className={card}>
      <h2 className="text-[15px] font-bold">Identidad</h2>
      <Field label="Nombre comercial" error={block.errors.name} hint="El que ven tu equipo y tus mensajes con {{empresa}}.">
        {(f) => <Input {...f} value={name} maxLength={100} disabled={!edit} onChange={(e) => { setName(e.target.value); block.touch(); }} />}
      </Field>
      <Footer edit={edit} block={block} />
    </form>
  );
}

function Location({ p }: { p: CompanyProfile }) {
  const block = useBlock();
  const [country, setCountry] = useState(p.country ?? '');
  const [zone, setZone] = useState(p.timezone);
  const [confirm, setConfirm] = useState(false);
  const edit = p.access.edit;
  const zones = timezones();
  const patch = (): ProfilePatch => ({ ...(country !== '' && country !== p.country ? { country } : {}), ...(zone !== p.timezone ? { timezone: zone } : {}) });
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (zone !== p.timezone) return setConfirm(true);
    block.run(patch());
  };
  return (
    <form aria-label="Ubicación y hora" onSubmit={submit} noValidate className={card}>
      <h2 className="text-[15px] font-bold">Ubicación y hora</h2>
      <Field label="País" error={block.errors.country} hint="Dato informativo de la empresa.">
        {(f) => (
          <select {...f} value={country} disabled={!edit} onChange={(e) => { setCountry(e.target.value); block.touch(); }} className={selectCls}>
            {p.country === null ? <option value="">Sin definir</option> : null}
            {countryOptions().map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        )}
      </Field>
      <Field label="Zona horaria" error={block.errors.timezone}>
        {(f) => (
          <select {...f} value={zone} disabled={!edit} onChange={(e) => { setZone(e.target.value); block.touch(); }} className={selectCls}>
            {(zones.includes(p.timezone) ? zones : [p.timezone, ...zones]).map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        )}
      </Field>
      <Field label="Moneda" hint={p.currency_locked_reason ?? 'Se cambia en Ventas mientras no haya ventas registradas.'}>
        {(f) => <Input {...f} value={p.currency} readOnly disabled />}
      </Field>
      <Footer edit={edit} block={block} />
      {confirm ? (
        <Modal title="Cambiar la zona horaria" onClose={() => setConfirm(false)}>
          <p className="text-[13.5px]">Pasar de <b>{p.timezone}</b> a <b>{zone}</b>.</p>
          {ZONE_EFFECTS.map((t) => <p key={t} className="text-[13px] text-muted">{t}</p>)}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirm(false)}>Cancelar</Button>
            <Button variant="primary" onClick={() => { setConfirm(false); block.run(patch()); }}>Cambiar zona horaria</Button>
          </div>
        </Modal>
      ) : null}
    </form>
  );
}

const CONTACT = [
  { key: 'legal_name', label: 'Razón social', max: 120 },
  { key: 'tax_id', label: 'Identificación fiscal', max: 32 },
  { key: 'contact_phone', label: 'Teléfono de contacto', max: 24, hint: 'Con el código del país, por ejemplo +593 98 765 4321.' },
  { key: 'contact_email', label: 'Correo de contacto', max: 254 },
  { key: 'website', label: 'Sitio web', max: 200, hint: 'Debe empezar por https://' },
  { key: 'address', label: 'Dirección', max: 200 },
  { key: 'city', label: 'Ciudad', max: 80 },
] as const;

function Contact({ p }: { p: CompanyProfile }) {
  const block = useBlock();
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries([...CONTACT.map((c) => c.key), 'description' as const].map((k) => [k, p[k] ?? ''])));
  const edit = p.access.edit;
  const set = (k: string, value: string): void => {
    setV((cur) => ({ ...cur, [k]: value }));
    block.touch();
  };
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const patch: Record<string, string | null> = {};
    for (const k of Object.keys(v) as Array<keyof ProfilePatch & string>) {
      let value: string = (v[k] ?? '').trim();
      if (k === 'contact_phone' && value !== '') {
        const e164 = normalizePhone(value, '+');
        if (!value.startsWith('+') || !e164) return block.setErrors({ contact_phone: 'Escribe el número con el código del país (empieza por +)' });
        value = e164;
      }
      const next = value === '' ? null : value;
      if (next !== ((p as unknown as Record<string, string | null>)[k] ?? null)) patch[k] = next;
    }
    block.run(patch as ProfilePatch);
  };
  return (
    <form aria-label="Datos de contacto" onSubmit={submit} noValidate className={card}>
      <h2 className="text-[15px] font-bold">Datos de contacto</h2>
      <p className="text-[12.5px] text-muted">Todos son opcionales y son datos de la empresa.</p>
      <div className="grid items-start gap-3 sm:grid-cols-2">
        {CONTACT.map((c) => (
          <Field key={c.key} label={c.label} error={block.errors[c.key]} {...('hint' in c ? { hint: c.hint } : {})}>
            {(f) => <Input {...f} value={v[c.key] ?? ''} maxLength={c.max} disabled={!edit} onChange={(e) => set(c.key, e.target.value)} />}
          </Field>
        ))}
      </div>
      <Field label="Descripción corta" error={block.errors.description}>
        {(f) => <textarea {...f} rows={3} maxLength={500} value={v['description'] ?? ''} disabled={!edit} onChange={(e) => set('description', e.target.value)} className={selectCls} />}
      </Field>
      <Footer edit={edit} block={block} />
    </form>
  );
}

/** Configuración › Empresa (V25, ADR-76): identidad, ubicación y hora, y datos de contacto. Cada bloque se guarda por separado. */
export function CompanyProfilePage() {
  const q = useCompanyProfile();
  return (
    <div className="grid gap-4">
      <SettingsNav />
      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando el perfil de la empresa" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar el perfil de la empresa.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.data ? (
        <>
          {!q.data.access.edit ? <Alert kind="info">Solo lectura: no puedes cambiar los datos de esta empresa.</Alert> : null}
          <Identity p={q.data} />
          <Location p={q.data} />
          <Contact p={q.data} />
        </>
      ) : null}
    </div>
  );
}
