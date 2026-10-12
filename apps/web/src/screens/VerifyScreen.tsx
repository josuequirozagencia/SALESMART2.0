import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { friendlyError } from '../lib/errors';
import { pendingSignup } from '../lib/pending';
import { useSession } from '../lib/session';
import { CAPTCHA_PENDING, useCaptcha } from '../lib/useCaptcha';
import { isEmail, isSixDigits, normalizeEmail } from '../lib/validation';
import { AuthShell, Title } from '../ui/AuthShell';
import { Alert, Button, Field, Input } from '../ui/controls';

/** Espera local antes de permitir otro reenvío (el servidor aplica su propio enfriamiento y límites). */
const RESEND_WAIT_SECONDS = 60;

export function VerifyScreen() {
  const nav = useNavigate();
  const { login } = useSession();
  const [email, setEmail] = useState(() => pendingSignup.get()?.email ?? '');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const emailKnown = Boolean(pendingSignup.get()?.email);
  const captcha = useCaptcha();

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setInfo(undefined);
    const em = normalizeEmail(email);
    if (!isEmail(em)) return setError('Escribe un correo válido');
    if (!isSixDigits(code)) return setError('Escribe los 6 dígitos');
    setError(undefined);
    setBusy(true);
    try {
      await api<{ status: string }>('/auth/verify', { method: 'POST', auth: false, body: { email: em, code } });
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
      return;
    }
    // Verificar el correo NO abre sesión (M1.2): se entra con la contraseña del registro, que solo estaba en memoria
    const password = pendingSignup.takePassword();
    try {
      if (password) {
        await login(em, password);
        pendingSignup.clear();
        nav('/', { replace: true });
        return;
      }
    } catch {
      /* cae al login normal */
    }
    pendingSignup.clear();
    nav('/login', { replace: true, state: { notice: 'Correo verificado. Inicia sesión para empezar tu prueba.' } });
  }

  async function resend() {
    const em = normalizeEmail(email);
    if (!isEmail(em)) return setError('Escribe un correo válido');
    const captchaTok = captcha.take();
    if (!captchaTok) return setError(CAPTCHA_PENDING);
    setError(undefined);
    try {
      await api<{ status: string }>('/auth/resend', { method: 'POST', auth: false, body: { email: em, captcha_token: captchaTok } });
      setInfo('Si tu registro está pendiente, te enviamos un código nuevo.');
      setWait(RESEND_WAIT_SECONDS);
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  return (
    <AuthShell kind="signup">
      <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-3.5" aria-label="Verificar correo">
        <div className="flex gap-1.5" aria-hidden="true"><i className="h-1 flex-1 rounded-sm [background:var(--grad)]" /><i className="h-1 flex-1 rounded-sm [background:var(--grad)]" /></div>
        <Title
          sub={emailKnown ? <>Enviamos un código de 6 dígitos a <b className="text-fg">{email}</b>. Vence en unos minutos.</> : 'Escribe tu correo y el código de 6 dígitos que te enviamos.'}
        >
          Verifica tu correo
        </Title>
        {!emailKnown ? (
          <Field label="Correo">{(p) => <Input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        ) : null}
        <Field label="Código">
          {(p) => (
            <Input {...p} inputMode="numeric" maxLength={6} autoComplete="one-time-code" placeholder="••••••" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="p-3 text-center font-mono text-[26px] tracking-[.5em]" />
          )}
        </Field>
        {captcha.widget}
        {error ? <Alert>{error}</Alert> : null}
        {info ? <Alert kind="ok">{info}</Alert> : null}
        <Button type="submit" variant="primary" block loading={busy}>Verificar y entrar</Button>
        <p className="text-center text-[13.5px] text-muted">
          ¿No llegó?{' '}
          {wait > 0 ? <span>Reenviar en {wait} s</span> : <Button variant="link" onClick={() => void resend()}>Reenviar código</Button>}
          {' · '}
          <Link to="/signup" className="font-semibold text-accent hover:underline">Cambiar correo</Link>
        </p>
      </form>
    </AuthShell>
  );
}
