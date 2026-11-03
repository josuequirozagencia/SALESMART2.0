import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { startDownload } from '../lib/download';
import { friendlyError } from '../lib/errors';
import { fileSize, shortDate } from '../lib/format';
import type { CompanyExport, ExportDownloadLink, OwnerExportStatus } from '../lib/types';
import { AuthShell, Title } from '../ui/AuthShell';
import { Alert, Button, Field, PasswordInput, Spinner } from '../ui/controls';

/**
 * El token llega en el FRAGMENTO del enlace (`/company-export#token=…`): no viaja a servidores, logs ni Referer. Se captura al montar y un efecto lo borra de la barra de direcciones (mismo patrón que
 * /accept-invite y /reset-password). Se manda en el cuerpo de cada petición, nunca en la dirección.
 */
function readTokenFromHash(): string {
  const m = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
  return m?.[1] ? decodeURIComponent(m[1]) : '';
}

const when = (iso: string): string => `${shortDate(iso)} ${new Date(iso).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })}`;

function BadLink() {
  return (
    <AuthShell>
      <Title sub="Puede que el plazo de recuperación ya haya terminado, que la empresa se haya recuperado o que te hayan enviado un enlace más reciente. Abre el enlace del último correo que recibiste.">Enlace no válido</Title>
    </AuthShell>
  );
}

/**
 * Página pública del dueño de una empresa eliminada (F3b, ADR-59 #9): no puede iniciar sesión, así que entra con el enlace de su correo. El enlace dice QUÉ empresa y su contraseña confirma QUIÉN es: se la pedimos
 * para pedir la copia y para bajarla. La copia se arma en segundo plano; mientras tanto la página consulta sola. Sin credenciales en el paquete.
 */
export function CompanyExportScreen() {
  const qc = useQueryClient();
  const [token] = useState(readTokenFromHash);
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }, []);

  const status = useQuery({
    queryKey: ['company-export', token],
    enabled: token !== '',
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
    refetchInterval: (q) => (q.state.data?.export && (q.state.data.export.state === 'queued' || q.state.data.export.state === 'running') ? 5000 : false),
    queryFn: () => api<OwnerExportStatus>('/public/company-export/status', { method: 'POST', auth: false, body: { token } }),
  });

  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();

  const request = useMutation({
    mutationFn: () => api<CompanyExport>('/public/company-export/request', { method: 'POST', auth: false, body: { token, password } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['company-export', token] }),
    onError: (e) => { setPassword(''); setError(friendlyError(e, 'No pudimos pedir la copia.')); },
  });
  const download = useMutation({
    mutationFn: (part: number) => api<ExportDownloadLink>('/public/company-export/download', { method: 'POST', auth: false, body: { token, password, part } }),
    onSuccess: (l) => startDownload(l.url, l.filename),
    onError: (e) => { setPassword(''); setError(friendlyError(e, 'No pudimos preparar la descarga.')); },
  });

  if (token === '') return <BadLink />;
  if (status.isPending) return <AuthShell><div className="grid place-items-center py-10 text-muted"><Spinner label="Comprobando el enlace" /></div></AuthShell>;
  if (status.isError) {
    if (status.error instanceof ApiError && status.error.status === 404) return <BadLink />;
    return (
      <AuthShell>
        <Title sub={friendlyError(status.error, 'No pudimos comprobar el enlace.')}>No pudimos abrir la página</Title>
        <Button block onClick={() => void status.refetch()}>Reintentar</Button>
      </AuthShell>
    );
  }

  const s = status.data;
  const ex = s.export;
  const building = ex?.state === 'queued' || ex?.state === 'running';
  const ready = ex?.state === 'ready';

  function ask(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (password === '') return;
    request.mutate();
  }

  return (
    <AuthShell>
      <Title sub={<>La cuenta de <b>{s.organization_name}</b> fue eliminada. Hasta el <b>{shortDate(s.purge_after)}</b> puedes pedir una copia completa de tus datos; después se borran de forma definitiva.</>}>Copia de tus datos</Title>

      {building ? (
        <div role="status" className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 text-[13.5px]">
          <Spinner label="Armando la copia" />
          <span>Estamos armando tu copia. Puede tardar varios minutos según el tamaño. Puedes dejar esta página abierta: se actualiza sola, y te avisaremos por correo cuando esté lista.</span>
        </div>
      ) : null}

      {ready && ex ? (
        <div className="grid gap-3">
          <Alert kind="ok">Tu copia está lista y se puede bajar hasta el <b>{when(ex.expires_at ?? ex.requested_at)}</b>; después la borramos. Total: {fileSize(ex.total_bytes)}.</Alert>
          <Field label="Tu contraseña" hint="Te la pedimos para confirmar que eres tú antes de entregarte los datos.">
            {(p) => <PasswordInput {...p} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <ul className="grid gap-2" aria-label="Partes de la copia">
            {ex.parts.map((p) => (
              <li key={p.n} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-3 text-[13px]">
                <span className="min-w-0"><b className="block truncate">{p.filename}</b><span className="text-muted">Parte {p.n} · {fileSize(p.bytes)}</span></span>
                <Button aria-label={`Bajar la parte ${p.n}`} disabled={password === ''} loading={download.isPending && download.variables === p.n} onClick={() => { setError(undefined); download.mutate(p.n); }}>Bajar</Button>
              </li>
            ))}
          </ul>
          {ex.parts.length > 1 ? <p className="text-[12px] text-muted">Cada parte es un ZIP independiente. Baja todas y descomprímelas en la misma carpeta; el archivo LEEME está en la primera.</p> : null}
          <p className="text-[12px] text-muted">No incluye contraseñas ni claves de tus conexiones: por seguridad nunca salen de la plataforma.</p>
        </div>
      ) : null}

      {ex?.state === 'failed' ? <Alert>No pudimos armar la copia. Puedes intentarlo de nuevo; si vuelve a fallar, escribe a quien te atiende en Sales Smart.</Alert> : null}
      {ex?.state === 'expired' ? <Alert kind="info">La copia anterior ya venció y se borró. Puedes pedir otra.</Alert> : null}

      {!building && !ready ? (
        <form onSubmit={ask} noValidate className="grid gap-3.5" aria-label="Pedir la copia de mis datos">
          <p className="text-[13.5px] text-muted">Incluye todos los datos de tu empresa (contactos, conversaciones, ventas, citas…), los CSV para abrir en una hoja de cálculo y tus archivos.</p>
          <Field label="Tu contraseña" hint="Te la pedimos para confirmar que eres tú.">
            {(p) => <PasswordInput {...p} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Button type="submit" variant="primary" block disabled={password === ''} loading={request.isPending}>Pedir la copia de mis datos</Button>
        </form>
      ) : null}

      {error ? <Alert>{error}</Alert> : null}
    </AuthShell>
  );
}
