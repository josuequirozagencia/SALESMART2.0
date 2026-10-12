import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { friendlyError } from '../lib/errors';
import { CAPTCHA_PENDING, useCaptcha } from '../lib/useCaptcha';
import { isEmail, normalizeEmail } from '../lib/validation';
import { AuthShell, Title } from '../ui/AuthShell';
import { Alert, Button, CheckIcon, Field, Input } from '../ui/controls';

export function ForgotScreen() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<string>();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const captcha = useCaptcha();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    const em = normalizeEmail(email);
    if (!isEmail(em)) return setFieldError('Escribe un correo válido');
    setFieldError(undefined);
    const captchaTok = captcha.take();
    if (!captchaTok) return setError(CAPTCHA_PENDING);
    setBusy(true);
    try {
      await api<{ status: string }>('/auth/forgot', { method: 'POST', auth: false, body: { email: em, captcha_token: captchaTok } });
      setSent(true); // el servidor responde igual exista o no la cuenta; la pantalla tampoco lo revela
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <AuthShell>
        <div className="grid size-14 place-items-center rounded-full bg-accent-soft text-accent"><CheckIcon className="size-[26px]" /></div>
        <Title sub={<>Si existe una cuenta con <b className="text-fg">{normalizeEmail(email)}</b>, te enviamos un enlace para crear una contraseña nueva. Vence en unos minutos.</>}>Revisa tu correo</Title>
        <Link to="/login" className="inline-flex w-full items-center justify-center rounded-[10px] border border-line bg-surface px-4 py-3 text-[14px] font-semibold hover:bg-surface2">Volver a iniciar sesión</Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-3.5" aria-label="Recuperar contraseña">
        <Title sub="Te enviaremos un enlace a tu correo.">Recupera tu contraseña</Title>
        <Field label="Correo" error={fieldError}>
          {(p) => <Input {...p} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@empresa.com" />}
        </Field>
        {captcha.widget}
        {error ? <Alert>{error}</Alert> : null}
        <Button type="submit" variant="primary" block loading={busy}>Enviar enlace</Button>
        <Link to="/login" className="inline-flex w-full items-center justify-center rounded-[10px] border border-line bg-surface px-4 py-3 text-[14px] font-semibold hover:bg-surface2">Volver</Link>
      </form>
    </AuthShell>
  );
}
