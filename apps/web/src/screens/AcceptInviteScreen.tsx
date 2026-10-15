import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { friendlyError } from '../lib/errors';
import { COUNTRIES, isE164, MIN_NATIONAL_DIGITS, nationalDigits, toE164 } from '../lib/phone';
import type { InvitationPreview } from '../lib/types';
import { passwordError } from '../lib/validation';
import { AuthShell, Title } from '../ui/AuthShell';
import { Alert, Button, Field, Input, PasswordInput, Spinner } from '../ui/controls';

/**
 * El token llega en el FRAGMENTO del enlace (`/accept-invite#token=…`): no viaja a servidores, logs ni Referer. Se captura al montar
 * (lectura pura e idempotente por StrictMode) y un efecto lo borra de la barra de direcciones. Mismo patrón que /reset-password.
 */
function readTokenFromHash(): string {
  const m = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
  return m?.[1] ? decodeURIComponent(m[1]) : '';
}

type Errors = { name?: string; phone?: string; password?: string; confirm?: string };

function BadLink({ expired }: { expired: boolean }) {
  return (
    <AuthShell>
      <Title sub={expired ? 'Las invitaciones duran 7 días. Pide a quien te invitó que te la reenvíe.' : 'Puede que ya la hayas usado o que te hayan enviado una más reciente.'}>
        {expired ? 'La invitación venció' : 'Invitación no válida'}
      </Title>
      <Link to="/login" className="inline-flex w-full items-center justify-center rounded-[10px] border border-accent bg-accent px-4 py-3 text-[14px] font-semibold text-accent-ink hover:brightness-110">Ir a iniciar sesión</Link>
    </AuthShell>
  );
}

/** Aceptar la invitación a una empresa: cuenta nueva (nombre, WhatsApp y contraseña) o cuenta existente (confirmar con su contraseña). */
export function AcceptInviteScreen() {
  const nav = useNavigate();
  const [token] = useState(readTokenFromHash);
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }, []);

  const preview = useQuery({
    queryKey: ['invitation', token],
    enabled: token !== '',
    staleTime: Infinity,
    queryFn: () => api<InvitationPreview>('/auth/invitations/preview', { method: 'POST', auth: false, body: { token } }),
  });

  const [name, setName] = useState('');
  const [country, setCountry] = useState<string>(COUNTRIES[0].code);
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string>();
  const [badLink, setBadLink] = useState<'invalid' | 'expired'>();
  const [busy, setBusy] = useState(false);

  if (token === '') return <BadLink expired={false} />;
  if (preview.isPending) return <AuthShell><div className="grid place-items-center py-10 text-muted"><Spinner label="Comprobando la invitación" /></div></AuthShell>;
  if (preview.isError) {
    const code = preview.error instanceof ApiError ? preview.error.code : '';
    if (code === 'INVALID_INVITATION' || code === 'INVITATION_EXPIRED') return <BadLink expired={code === 'INVITATION_EXPIRED'} />;
    return (
      <AuthShell>
        <Title sub={friendlyError(preview.error, 'No pudimos comprobar la invitación.')}>No pudimos abrir la invitación</Title>
        <Button block onClick={() => void preview.refetch()}>Reintentar</Button>
      </AuthShell>
    );
  }
  if (badLink) return <BadLink expired={badLink === 'expired'} />;

  const inv = preview.data;
  const existing = inv.account_exists;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Errors = {};
    const fullName = name.trim();
    const e164 = toE164(country, phone);
    if (!existing) {
      if (fullName.length < 2) next.name = 'Escribe tu nombre';
      else if (fullName.length > 100) next.name = 'Usa como máximo 100 caracteres';
      if (nationalDigits(phone) < MIN_NATIONAL_DIGITS || !isE164(e164)) next.phone = 'Escribe un número de WhatsApp válido';
      const pw = passwordError(password);
      if (pw) next.password = pw;
      if (confirm !== password) next.confirm = 'Las contraseñas no coinciden';
    } else if (password === '') {
      next.password = 'Escribe tu contraseña actual';
    }
    setErrors(next);
    setFormError(undefined);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    try {
      await api<{ status: string }>('/auth/invitations/accept', { method: 'POST', auth: false, body: { token, password, ...(existing ? {} : { full_name: fullName, phone: e164 }) } });
      nav('/login', { replace: true, state: { notice: existing ? `Listo: ya tienes acceso a ${inv.organization_name}. Inicia sesión con tu contraseña de siempre.` : `Cuenta lista. Inicia sesión con ${inv.email} y la contraseña que elegiste.` } });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVITATION_EXPIRED') setBadLink('expired');
      else if (err instanceof ApiError && err.code === 'INVALID_INVITATION') setBadLink('invalid');
      else if (err instanceof ApiError && err.code === 'INVALID_PASSWORD') setErrors({ password: 'La contraseña no es correcta' });
      else if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
        const by = (p: string) => err.details.find((d) => d.path === p)?.message;
        setErrors({ ...(by('full_name') ? { name: 'Revisa tu nombre' } : {}), ...(by('phone') ? { phone: 'Revisa tu número de WhatsApp' } : {}), ...(by('password') ? { password: by('password')! } : {}) });
      } else setFormError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-3.5" aria-label="Aceptar invitación">
        <Title sub={<>Te invitaron a administrar <b>{inv.organization_name}</b> con <b>{inv.email}</b>.</>}>
          {existing ? 'Confirma tu identidad' : 'Crea tu cuenta'}
        </Title>
        {existing ? (
          <Field label="Tu contraseña actual" error={errors.password} hint="Este correo ya tiene una cuenta en Sales Smart. No cambiaremos tu contraseña: solo añadiremos esta empresa.">
            {(p) => <PasswordInput {...p} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
        ) : (
          <>
            <Field label="Nombre completo" error={errors.name}>
              {(p) => <Input {...p} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Dora Quinde" />}
            </Field>
            <Field label="WhatsApp" error={errors.phone}>
              {(p) => (
                <span className="grid grid-cols-[104px_1fr] gap-2">
                  <select aria-label="Prefijo del país" value={country} onChange={(e) => setCountry(e.target.value)} className="w-full rounded-[10px] border border-line bg-surface px-2 py-[11px] text-[14px]">
                    {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
                  </select>
                  <Input {...p} type="tel" inputMode="tel" autoComplete="tel-national" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="098 765 4321" />
                </span>
              )}
            </Field>
            <Field label="Contraseña" error={errors.password} hint="Mínimo 8 caracteres.">
              {(p) => <PasswordInput {...p} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
            </Field>
            <Field label="Repite la contraseña" error={errors.confirm}>
              {(p) => <PasswordInput {...p} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
            </Field>
          </>
        )}
        {formError ? <Alert>{formError}</Alert> : null}
        <Button type="submit" variant="primary" block loading={busy}>{existing ? 'Añadir esta empresa' : 'Crear cuenta y entrar'}</Button>
      </form>
    </AuthShell>
  );
}
