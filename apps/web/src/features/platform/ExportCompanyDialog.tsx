import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { fileSize, shortDate } from '../../lib/format';
import { startDownload } from '../../lib/download';
import type { Company, CompanyExport } from '../../lib/types';
import { Alert, Button, Field, PasswordInput, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useCompanyExport, useCompanyExportDownload, useRequestCompanyExport } from './useCompanies';

const when = (iso: string): string => `${shortDate(iso)} ${new Date(iso).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })}`;

/**
 * «Descargar todo» de una empresa eliminada (F3b, ADR-59 #8): una copia completa de sus datos en uno o varios ZIP. Se arma en segundo plano (puede tardar según el tamaño; se puede cerrar la ventana) y queda
 * lista 48 horas. Pedirla exige la contraseña del Súper Admin; bajarla, solo la sesión. Nada de credenciales entra al paquete.
 */
export function ExportCompanyDialog({ company, onClose }: { company: Company; onClose: () => void }) {
  const status = useCompanyExport(company.id);
  const request = useRequestCompanyExport();
  const download = useCompanyExportDownload();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();

  const ex: CompanyExport | null = status.data?.export ?? null;
  const building = ex?.state === 'queued' || ex?.state === 'running';
  const ready = ex?.state === 'ready';

  function ask() {
    setError(undefined);
    request.mutate({ id: company.id, password }, { onSuccess: () => setPassword(''), onError: (e) => { setPassword(''); setError(friendlyError(e, 'No pudimos pedir la copia.')); } });
  }

  function get(part: number) {
    setError(undefined);
    download.mutate({ id: company.id, part }, { onSuccess: (l) => startDownload(l.url, l.filename), onError: (e) => setError(friendlyError(e, 'No pudimos preparar la descarga.')) });
  }

  return (
    <Modal title={`Descargar todo de ${company.name}`} onClose={onClose}>
      {status.isPending ? <div className="grid place-items-center py-6 text-muted"><Spinner label="Consultando" /></div> : null}
      {status.isError ? <Alert>{friendlyError(status.error, 'No pudimos consultar la copia.')}</Alert> : null}

      {status.data && !status.data.available ? <Alert>Solo se puede pedir la copia de una empresa eliminada que todavía está dentro de su plazo.</Alert> : null}

      {status.data?.available ? (
        <>
          <p className="text-[13px] text-muted">
            Una copia completa de los datos de <b className="text-fg">{company.name}</b>: todas sus tablas, los CSV de lo que se abre en una hoja de cálculo y sus archivos. <b className="text-fg">No incluye credenciales ni secretos.</b>{' '}
            {status.data.purge_after ? <>Después del <b className="text-fg">{shortDate(status.data.purge_after)}</b> ya no se podrá pedir: los datos se borran de forma definitiva.</> : null}
          </p>

          {building ? (
            <div role="status" className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 text-[13px]">
              <Spinner label="Armando la copia" />
              <span>Armando la copia{ex?.requested_via === 'owner' ? ' (la pidió el dueño)' : ''}. Puede tardar varios minutos según el tamaño; puedes cerrar esta ventana y volver.</span>
            </div>
          ) : null}

          {ready && ex ? (
            <div className="grid gap-2">
              <Alert kind="ok">La copia está lista y se puede bajar hasta el <b>{when(ex.expires_at ?? ex.requested_at)}</b>; después se borra. Total: {fileSize(ex.total_bytes)}.</Alert>
              <ul className="grid gap-2" aria-label="Partes de la copia">
                {ex.parts.map((p) => (
                  <li key={p.n} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-3 text-[13px]">
                    <span className="min-w-0"><b className="block truncate">{p.filename}</b><span className="text-muted">Parte {p.n} · {fileSize(p.bytes)}</span></span>
                    <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Bajar la parte ${p.n}`} loading={download.isPending && download.variables?.part === p.n} onClick={() => get(p.n)}>Bajar</Button>
                  </li>
                ))}
              </ul>
              {ex.parts.length > 1 ? <p className="text-[12px] text-muted">Cada parte es un ZIP independiente. Baja todas y descomprímelas en la misma carpeta; el LEEME está en la primera.</p> : null}
            </div>
          ) : null}

          {ex?.state === 'failed' ? <Alert>No se pudo armar la copia. Puedes intentarlo de nuevo{ex.error === 'STORAGE_NOT_CONFIGURED' ? '; antes configura el almacenamiento en Proveedores' : ''}.</Alert> : null}
          {ex?.state === 'expired' ? <Alert kind="info">La copia anterior ya venció y se borró. Puedes pedir otra.</Alert> : null}

          {!building && !ready ? (
            <>
              <Field label="Tu contraseña" required hint="Es un volcado completo de los datos de un cliente: te la pedimos para confirmar que eres tú.">
                {(p) => <PasswordInput {...p} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />}
              </Field>
              <div className="flex justify-end gap-2">
                <Button onClick={onClose}>Cerrar</Button>
                <Button variant="primary" disabled={password.length === 0} loading={request.isPending} onClick={ask}>Preparar la copia</Button>
              </div>
            </>
          ) : (
            <div className="flex justify-end"><Button onClick={onClose}>Cerrar</Button></div>
          )}
        </>
      ) : status.data ? <div className="flex justify-end"><Button onClick={onClose}>Cerrar</Button></div> : null}

      {error ? <Alert>{error}</Alert> : null}
    </Modal>
  );
}
