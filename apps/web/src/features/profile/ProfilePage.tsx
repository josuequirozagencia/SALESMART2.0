import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import { ROLE_LABEL } from '../../lib/format';
import { normalizePhone } from '../../lib/phone';
import { useSession } from '../../lib/session';
import { passwordError } from '../../lib/validation';
import { Alert, Button, Field, Input, PasswordInput, Spinner } from '../../ui/controls';
import { PAGE_TITLE } from '../../ui/PageHeader';
import { MyPhoto } from '../photos/MyPhoto';
import { WEEKDAYS } from '../sla/hours';
import { useChangePassword, useMyProfile, useSaveMyProfile, type MyProfile } from './useMyProfile';

const card = 'grid gap-3 rounded-2xl border border-line bg-surface p-4';
const saved = (on: boolean) => <span role="status" aria-live="polite" className="text-[13px] font-semibold text-ok">{on ? 'Guardado' : ''}</span>;
type Errors = Partial<Record<string, string>>;

function Personal({ p }: { p: MyProfile }) {
  const save = useSaveMyProfile();
  const [name, setName] = useState(p.full_name ?? '');
  const [phone, setPhone] = useState(p.phone ?? '');
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    setError(undefined);
    setDone(false);
    const patch: { full_name?: string; phone?: string } = {};
    const next: Errors = {};
    const n = name.trim();
    if (n !== (p.full_name ?? '')) {
      if (n.length < 2) next.full_name = 'Escribe tu nombre (al menos 2 caracteres)';
      else patch.full_name = n;
    }
    const raw = phone.trim();
    if (raw !== (p.phone ?? '')) {
      const e164 = raw.startsWith('+') ? normalizePhone(raw, '+') : null;
      if (raw === '') next.phone = 'El teléfono se puede cambiar, pero no dejar vacío';
      else if (!e164) next.phone = 'Escribe el número con el código del país (empieza por +)';
      else patch.phone = e164;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    if (Object.keys(patch).length === 0) return setDone(true);
    save.mutate(patch, {
      onSuccess: () => setDone(true),
      onError: (err) => {
        if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') setErrors(Object.fromEntries(err.details.map((d) => [d.path, d.message])));
        setError(friendlyError(err, 'No pudimos guardar los cambios.'));
      },
    });
  };
  return (
    <form aria-label="Mis datos" onSubmit={submit} noValidate className={card}>
      <h2 className="text-[15px] font-bold">Mis datos</h2>
      <Field label="Nombre completo" error={errors.full_name} hint="Este nombre lo verán todas tus empresas.">
        {(f) => <Input {...f} autoComplete="name" maxLength={100} value={name} onChange={(e) => { setName(e.target.value); setDone(false); }} />}
      </Field>
      <Field label="Teléfono" error={errors.phone} hint="Con el código del país, por ejemplo +593 98 765 4321. También vale para todas tus empresas.">
        {(f) => <Input {...f} type="tel" inputMode="tel" autoComplete="tel" maxLength={24} value={phone} onChange={(e) => { setPhone(e.target.value); setDone(false); }} />}
      </Field>
      <Field label="Correo" hint="Para cambiar tu correo, contacta con tu administrador.">
        {(f) => <Input {...f} type="email" value={p.email} readOnly disabled />}
      </Field>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {saved(done)}
        <Button type="submit" variant="primary" loading={save.isPending}>Guardar</Button>
      </div>
    </form>
  );
}

function Password() {
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    setError(undefined);
    setDone(false);
    const found: Errors = {};
    if (current === '') found.current_password = 'Escribe tu contraseña actual';
    const weak = passwordError(next);
    if (weak) found.new_password = weak;
    if (again !== next) found.again = 'Las contraseñas no coinciden';
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    change.mutate(
      { current_password: current, new_password: next },
      {
        onSuccess: () => { setCurrent(''); setNext(''); setAgain(''); setDone(true); },
        onError: (err) => {
          if (err instanceof ApiError && err.code === 'INVALID_CURRENT_PASSWORD') return setErrors({ current_password: 'La contraseña actual no es correcta' });
          if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') return setErrors(Object.fromEntries(err.details.map((d) => [d.path, d.message])));
          setError(friendlyError(err, 'No pudimos cambiar la contraseña.'));
        },
      },
    );
  };
  return (
    <form aria-label="Cambiar contraseña" onSubmit={submit} noValidate className={card}>
      <h2 className="text-[15px] font-bold">Cambiar contraseña</h2>
      <p className="text-[12.5px] text-muted">Al cambiarla se cierran tus otras sesiones.</p>
      <Field label="Contraseña actual" error={errors.current_password}>{(f) => <PasswordInput {...f} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
      <Field label="Contraseña nueva" error={errors.new_password} hint="Mínimo 8 caracteres.">{(f) => <PasswordInput {...f} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
      <Field label="Repite la contraseña nueva" error={errors.again}>{(f) => <PasswordInput {...f} autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />}</Field>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <span role="status" aria-live="polite" className="text-[13px] font-semibold text-ok">{done ? 'Contraseña cambiada' : ''}</span>
        <Button type="submit" variant="primary" loading={change.isPending}>Cambiar contraseña</Button>
      </div>
    </form>
  );
}

function Hours({ p }: { p: MyProfile }) {
  if (p.time_zone === null) return null;
  return (
    <section aria-label="Mi horario" className={card}>
      <h2 className="text-[15px] font-bold">Mi horario</h2>
      {p.hours === null ? <p className="text-[13px] text-muted">No tienes un horario propio: estás disponible según el horario de la empresa.</p> : (
        <>
          <dl className="grid gap-1 text-[13px]">
            {WEEKDAYS.map((d) => <div key={d.key} className="flex justify-between gap-3"><dt>{d.label}</dt><dd className="text-right text-muted">{p.hours![d.key].length === 0 ? 'Cerrado' : p.hours![d.key].map(([from, to]) => `${from}–${to}`).join(', ')}</dd></div>)}
          </dl>
          <p className="text-[12.5px] text-muted">Zona horaria: {p.time_zone}. Solo lo cambia un administrador.</p>
        </>
      )}
    </section>
  );
}

/** «Mi perfil» (V25, ADR-76): los datos propios y los accesos a lo que ya existe. El correo, el rol y la empresa son de solo lectura. */
export function ProfilePage() {
  const q = useMyProfile();
  const { state } = useSession();
  const me = state.status === 'authed' ? state.me : null;
  return (
    <div className="grid gap-4">
      <h1 className={PAGE_TITLE}>Mi perfil</h1>
      {me ? (
        <section aria-label="Rol y empresa" className={card}>
          <dl className="grid gap-2 text-[13px] sm:grid-cols-2">
            <div><dt className="text-[12px] text-muted">Rol</dt><dd className="font-semibold">{ROLE_LABEL[me.role] ?? me.role}</dd></div>
            <div><dt className="text-[12px] text-muted">Empresa</dt><dd className="break-words font-semibold">{me.organization.name}</dd></div>
          </dl>
          {me.organization.kind === 'client' ? (
            <div className="flex flex-wrap gap-2">
              <Link to="/settings/appearance" className="inline-flex min-h-11 items-center rounded-[10px] border border-line px-3 text-[13px] font-semibold hover:bg-surface2">Apariencia</Link>
              <Link to="/settings/notifications" className="inline-flex min-h-11 items-center rounded-[10px] border border-line px-3 text-[13px] font-semibold hover:bg-surface2">Notificaciones</Link>
            </div>
          ) : null}
        </section>
      ) : null}
      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando tu perfil" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar tu perfil.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.data ? (
        <>
          <Personal p={q.data} />
          {q.data.photo ? <MyPhoto /> : null}
          <Hours p={q.data} />
          <Password />
        </>
      ) : null}
    </div>
  );
}
