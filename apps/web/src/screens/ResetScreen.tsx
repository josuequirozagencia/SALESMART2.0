import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { friendlyError } from '../lib/errors';
import { passwordError } from '../lib/validation';
import { AuthShell, Title } from '../ui/AuthShell';
import { Alert, Button, Field, PasswordInput } from '../ui/controls';

/**
 * El token llega en el FRAGMENTO del enlace (`/reset-password#token=…`): no viaja a servidores, logs ni Referer.
 * Se captura al montar y un efecto lo borra de la barra de direcciones.
 */
function readTokenFromHash(): string {
  // Puro e idempotente (StrictMode ejecuta el inicializador dos veces): NO modifica la URL; eso lo hace un efecto
  const m = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
  return m?.[1] ? decodeURIComponent(m[1]) : '';
}

export function ResetScreen() {
  const nav = useNavigate();
  const [token] = useState(readTokenFromHash);
  useEffect(() => {
    // Ya capturado en el estado: se borra de la barra de direcciones (no queda en el historial ni se comparte por error)
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }, []);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [error, setError] = useState<string>();
  const [badLink, setBadLink] = useState(token === '');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    const pw = passwordError(password);
    if (pw) next.password = pw;
    if (confirm !== password) next.confirm = 'Las contraseñas no coinciden';
    setErrors(next);
    setError(undefined);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    try {
      await api<{ status: string }>('/auth/reset', { method: 'POST', auth: false, body: { token, new_password: password } });
      nav('/login', { replace: true, state: { notice: 'Contraseña actualizada. Inicia sesión con la nueva.' } });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_TOKEN') setBadLink(true);
      else if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') setErrors({ password: err.details[0]?.message ?? 'La contraseña no es válida' });
      else setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  if (badLink) {
    return (
      <AuthShell>
        <Title sub="Los enlaces de recuperación vencen y solo se pueden usar una vez.">Enlace inválido o vencido</Title>
        <Link to="/forgot" className="inline-flex w-full items-center justify-center rounded-[10px] border border-accent bg-accent px-4 py-3 text-[14px] font-semibold text-accent-ink hover:brightness-110">Pedir un enlace nuevo</Link>
        <Link to="/login" className="text-center text-[13.5px] font-semibold text-accent hover:underline">Volver a iniciar sesión</Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-3.5" aria-label="Crear contraseña nueva">
        <Title sub="Al guardarla cerraremos tus sesiones abiertas en otros equipos.">Crea tu contraseña nueva</Title>
        <Field label="Contraseña nueva" error={errors.password} hint="Mínimo 8 caracteres.">
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Field label="Repite la contraseña" error={errors.confirm}>
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
        </Field>
        {error ? <Alert>{error}</Alert> : null}
        <Button type="submit" variant="primary" block loading={busy}>Guardar contraseña</Button>
      </form>
    </AuthShell>
  );
}
