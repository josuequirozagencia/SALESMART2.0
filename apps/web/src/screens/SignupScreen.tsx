import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { captchaToken } from '../lib/captcha';
import { friendlyError } from '../lib/errors';
import { pendingSignup } from '../lib/pending';
import { COUNTRIES, isE164, MIN_NATIONAL_DIGITS, nationalDigits, toE164 } from '../lib/phone';
import { isEmail, normalizeEmail, passwordError } from '../lib/validation';
import { AuthShell, Title } from '../ui/AuthShell';
import { Alert, Button, Field, Input, PasswordInput } from '../ui/controls';

type Errors = { name?: string; company?: string; email?: string; phone?: string; password?: string; terms?: string };

export function SignupScreen() {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState<string>(COUNTRIES[0].code);
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [terms, setTerms] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Errors = {};
    const fullName = name.trim();
    const org = company.trim();
    const e164 = toE164(country, phone);
    if (fullName.length < 2) next.name = 'Escribe tu nombre';
    else if (fullName.length > 100) next.name = 'Usa como máximo 100 caracteres';
    if (org.length < 2) next.company = 'Escribe el nombre de tu empresa';
    else if (org.length > 100) next.company = 'Usa como máximo 100 caracteres';
    if (!isEmail(normalizeEmail(email))) next.email = 'Escribe un correo válido';
    if (nationalDigits(phone) < MIN_NATIONAL_DIGITS || !isE164(e164)) next.phone = 'Escribe un número de WhatsApp válido';
    const pw = passwordError(password);
    if (pw) next.password = pw;
    if (!terms) next.terms = 'Debes aceptar los términos para continuar';
    setErrors(next);
    setFormError(undefined);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    try {
      await api<{ status: string }>('/auth/signup', {
        method: 'POST',
        auth: false,
        body: {
          email: normalizeEmail(email),
          password,
          full_name: fullName,
          phone: e164,
          organization_name: org,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          captcha_token: captchaToken(),
        },
      });
      pendingSignup.set({ email: normalizeEmail(email), password });
      nav('/verify');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
        const fields: Errors = {};
        for (const d of err.details) {
          if (d.path === 'email') fields.email = 'Escribe un correo válido';
          else if (d.path === 'password') fields.password = d.code === 'too_short' ? d.message : 'La contraseña no es válida';
          else if (d.path === 'organization_name') fields.company = 'El nombre de la empresa no es válido';
          else if (d.path === 'full_name') fields.name = 'El nombre no es válido';
          else if (d.path === 'phone') fields.phone = 'Escribe un número de WhatsApp válido';
        }
        if (Object.keys(fields).length > 0) setErrors(fields);
        else setFormError(friendlyError(err));
      } else {
        setFormError(friendlyError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell kind="signup">
      <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-3.5" aria-label="Crear cuenta">
        <div className="flex gap-1.5" aria-hidden="true"><i className="h-1 flex-1 rounded-sm [background:var(--grad)]" /><i className="h-1 flex-1 rounded-sm bg-line" /></div>
        <Title sub="Prueba gratis con acceso a todo. No necesitas tarjeta.">Crea tu cuenta</Title>
        <div className="grid gap-3.5 min-[480px]:grid-cols-2">
          <Field label="Nombre completo" error={errors.name}>
            {(p) => <Input {...p} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ana Pérez" />}
          </Field>
          <Field label="Empresa" error={errors.company}>
            {(p) => <Input {...p} autoComplete="organization" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Mi empresa" />}
          </Field>
        </div>
        <Field label="Correo de trabajo" error={errors.email}>
          {(p) => <Input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@empresa.com" />}
        </Field>
        <Field label="WhatsApp" error={errors.phone} hint="Solo para dar seguimiento a tu prueba.">
          {(p) => (
            <span className="grid grid-cols-[104px_1fr] gap-2">
              <select aria-label="País" value={country} onChange={(e) => setCountry(e.target.value)} className="w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal">
                {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
              </select>
              <Input {...p} type="tel" autoComplete="tel-national" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98 421 7730" />
            </span>
          )}
        </Field>
        <Field label="Contraseña" error={errors.password} hint="Mínimo 8 caracteres.">
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <div className="grid gap-1">
          <label className="flex items-start gap-2 text-[12.5px] font-normal text-muted">
            <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" aria-invalid={errors.terms ? true : undefined} />
            <span>Acepto los términos de servicio y la política de privacidad (se publicarán antes del lanzamiento).</span>
          </label>
          {errors.terms ? <span role="alert" className="text-[12px] font-medium text-crit">{errors.terms}</span> : null}
        </div>
        {formError ? <Alert>{formError}</Alert> : null}
        <Button type="submit" variant="primary" block loading={busy}>Crear cuenta y empezar la prueba</Button>
        <p className="text-center text-[13.5px] text-muted">
          ¿Ya tienes cuenta? <Link to="/login" className="font-semibold text-accent hover:underline">Inicia sesión</Link>
        </p>
      </form>
    </AuthShell>
  );
}
