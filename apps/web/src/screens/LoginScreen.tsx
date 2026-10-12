import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { friendlyError } from '../lib/errors';
import { useSession } from '../lib/session';
import { isEmail, normalizeEmail } from '../lib/validation';
import { AuthShell, Title } from '../ui/AuthShell';
import { Alert, Button, Field, Input, PasswordInput } from '../ui/controls';

export function LoginScreen() {
  const { login } = useSession();
  const nav = useNavigate();
  const notice = (useLocation().state as { notice?: string } | null)?.notice;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!isEmail(normalizeEmail(email))) next.email = 'Escribe un correo válido';
    if (!password) next.password = 'Escribe tu contraseña';
    setErrors(next);
    setFormError(undefined);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    try {
      await login(normalizeEmail(email), password);
      nav('/', { replace: true });
    } catch (err) {
      setFormError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-3.5" aria-label="Iniciar sesión">
        <Title sub="Entra con tu correo y contraseña.">Inicia sesión</Title>
        {notice ? <Alert kind="ok">{notice}</Alert> : null}
        <Field label="Correo" error={errors.email}>
          {(p) => <Input {...p} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@empresa.com" />}
        </Field>
        <Field label="Contraseña" error={errors.password}>
          {(p) => <PasswordInput {...p} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />}
        </Field>
        <div className="-mt-1.5 text-right text-[12px]">
          <Link to="/forgot" className="font-semibold text-accent hover:underline">¿Olvidaste tu contraseña?</Link>
        </div>
        {formError ? <Alert>{formError}</Alert> : null}
        <Button type="submit" variant="primary" block loading={busy}>Entrar</Button>
        <div className="flex items-center gap-2.5 text-[12px] text-muted before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">o</div>
        <Link to="/signup" className="inline-flex w-full items-center justify-center rounded-[10px] border border-line bg-surface px-4 py-3 text-[14px] font-semibold hover:bg-surface2">
          Crear cuenta gratis
        </Link>
      </form>
    </AuthShell>
  );
}
