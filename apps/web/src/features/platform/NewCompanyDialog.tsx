import { useMemo, useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { countryOptions, DEFAULT_COUNTRY, suggestedTimezone, timezones } from '../../lib/countries';
import { friendlyError } from '../../lib/errors';
import { isEmail, normalizeEmail } from '../../lib/validation';
import type { CompanyCreated, Plan } from '../../lib/types';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { InviteResult } from './InviteResult';
import { useCreateCompany } from './useCompanies';

type Errors = { name?: string; email?: string; country?: string; timezone?: string };
const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal';

/**
 * «Nueva empresa» (F01): nombre, correo del dueño, país, zona horaria (el SLA depende de ella) y plan opcional. Al crearla, el dueño recibe una
 * invitación por correo; si el correo no puede salir, aquí se muestra el enlace para entregarlo por otro medio.
 */
export function NewCompanyDialog({ plans, kind = 'client', onClose }: { plans: Plan[]; kind?: 'client' | 'agency'; onClose: () => void }) {
  const agency = kind === 'agency';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState(DEFAULT_COUNTRY);
  const [timezone, setTimezone] = useState(suggestedTimezone(DEFAULT_COUNTRY) ?? 'UTC');
  const [planId, setPlanId] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string>();
  const [created, setCreated] = useState<CompanyCreated>();
  const create = useCreateCompany(kind);
  // Las ~850 opciones (países y zonas) se crean UNA vez: sin esto cada tecla en los campos de texto las re-renderizaba todas
  const countryItems = useMemo(() => countryOptions().map((c) => <option key={c.code} value={c.code}>{c.name}</option>), []);
  const zones = useMemo(() => timezones(), []);
  const zoneItems = useMemo(() => zones.map((z) => <option key={z} value={z}>{z}</option>), [zones]);

  function pickCountry(code: string) {
    setCountry(code);
    const tz = suggestedTimezone(code);
    if (tz) setTimezone(tz);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const next: Errors = {};
    const n = name.trim();
    if (n.length < 2) next.name = 'Escribe el nombre de la empresa';
    else if (n.length > 100) next.name = 'Usa como máximo 100 caracteres';
    if (!isEmail(normalizeEmail(email))) next.email = 'Escribe un correo válido';
    if (!country) next.country = 'Elige el país';
    if (!timezone) next.timezone = 'Elige la zona horaria';
    setErrors(next);
    setFormError(undefined);
    if (Object.keys(next).length > 0) return;
    create.mutate(
      { name: n, owner_email: normalizeEmail(email), timezone, country, plan_id: agency ? null : planId || null },
      {
        onSuccess: setCreated,
        onError: (err) => {
          if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
            const paths = err.details.map((d) => d.path);
            setErrors({ ...(paths.includes('owner_email') ? { email: 'Escribe un correo válido' } : {}), ...(paths.includes('country') ? { country: 'Elige un país válido' } : {}), ...(paths.includes('timezone') ? { timezone: 'Elige una zona horaria válida' } : {}), ...(paths.includes('name') ? { name: 'Revisa el nombre' } : {}) });
          }
          setFormError(friendlyError(err, 'No pudimos crear la empresa. Inténtalo de nuevo.'));
        },
      },
    );
  }

  if (created) {
    return (
      <Modal title={agency ? 'Agencia creada' : 'Empresa creada'} onClose={onClose}>
        <p className="text-[13.5px]"><b>{created.company.name}</b> quedó {agency ? 'creada' : 'creada'}{created.company.plan ? <> con el plan <b>{created.company.plan.name}</b></> : null}.</p>
        <InviteResult invitation={created.invitation} />
        <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Listo</Button></div>
      </Modal>
    );
  }

  return (
    <Modal title={agency ? 'Nueva agencia' : 'Nueva empresa'} onClose={onClose}>
      <form onSubmit={submit} noValidate className="grid gap-3" aria-label={agency ? 'Nueva agencia' : 'Nueva empresa'}>
        <Field label={agency ? 'Nombre de la agencia' : 'Nombre de la empresa'} error={errors.name}>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" placeholder={agency ? 'Agencia Digital Sur' : 'Barbería Norte'} />}
        </Field>
        <Field label="Correo del dueño" error={errors.email} hint={agency ? 'Le enviaremos una invitación para elegir su contraseña y administrar la agencia. Vence en 7 días.' : 'Le enviaremos una invitación para elegir su contraseña. Vence en 7 días.'}>
          {(p) => <Input {...p} type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" placeholder="dueno@empresa.com" />}
        </Field>
        <div className="grid gap-3 min-[520px]:grid-cols-2">
          <Field label="País" error={errors.country}>
            {(p) => (
              <select {...p} value={country} onChange={(e) => pickCountry(e.target.value)} className={selectCls}>
                {countryItems}
              </select>
            )}
          </Field>
          <Field label="Zona horaria" error={errors.timezone}>
            {(p) => (
              <select {...p} value={timezone} onChange={(e) => setTimezone(e.target.value)} className={selectCls}>
                {!zones.includes(timezone) ? <option value={timezone}>{timezone}</option> : null}
                {zoneItems}
              </select>
            )}
          </Field>
        </div>
        {agency ? null : <Field label="Plan" hint={planId ? 'Con plan no hay prueba gratuita. El cobro es manual hasta definir la pasarela de pagos.' : 'Sin plan, la prueba de 7 días empieza cuando el dueño acepte la invitación.'}>
          {(p) => (
            <select {...p} value={planId} onChange={(e) => setPlanId(e.target.value)} className={selectCls}>
              <option value="">Sin plan (prueba de 7 días)</option>
              {plans.map((pl) => <option key={pl.id} value={pl.id}>{pl.name}</option>)}
            </select>
          )}
        </Field>}
        {formError ? <Alert>{formError}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>Crear e invitar</Button>
        </div>
      </form>
    </Modal>
  );
}
