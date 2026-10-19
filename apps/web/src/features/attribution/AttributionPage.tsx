import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import type { AttributionEndpointIssued } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { CopyField } from '../../ui/CopyField';
import { SettingsNav } from '../app/SettingsNav';
import { useAttributionEndpoint, useIssueEndpoint } from './useAttribution';

const EXAMPLE = `{
  "phone": "+593984217730",
  "ctwa_cl_id": "<ID del clic de Click-to-WhatsApp>",
  "campaign_name": "<nombre de la campaña>",
  "adset_name": "<nombre del conjunto de anuncios>",
  "ad_name": "<nombre del anuncio>"
}`;

/**
 * Configuración › Atribución de Meta (M3.3, ADR-45). El administrador genera el punto de entrada por el que GoHighLevel avisa de cada clic de
 * Click-to-WhatsApp. La URL es la de esta misma aplicación; el secreto solo se muestra al generarlo (no se puede volver a ver, solo regenerar).
 */
export function AttributionPage() {
  const q = useAttributionEndpoint();
  const issue = useIssueEndpoint();
  const [issued, setIssued] = useState<AttributionEndpointIssued>();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();

  const full = (path: string): string => `${window.location.origin}${path}`;
  function generate() {
    setError(undefined);
    issue.mutate(undefined, { onSuccess: (r) => { setIssued(r); setConfirm(false); }, onError: (e) => { setConfirm(false); setError(friendlyError(e, 'No pudimos generar el punto de entrada.')); } });
  }

  const s = q.data;
  return (
    <div className="grid gap-4">
      <SettingsNav />
      <p className="max-w-[680px] text-[13.5px] text-muted">
        Cuando una persona llega por un anuncio de Facebook o Instagram que abre WhatsApp, GoHighLevel puede avisarnos para que el contacto quede con su campaña, conjunto y anuncio de origen.
      </p>

      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'Solo el administrador de la empresa puede ver y cambiar esto.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}

      {issued ? (
        <section aria-label="Datos del punto de entrada" className="grid gap-3 rounded-2xl border border-accent bg-accent-soft p-4">
          <Alert kind="info">Guarda el secreto ahora: <b>no se volverá a mostrar</b>. Si lo pierdes, genera uno nuevo (el anterior dejará de funcionar).</Alert>
          <CopyField label="URL del punto de entrada" value={full(issued.path)} />
          <CopyField label="Secreto" value={issued.secret} />
          <div><Button variant="primary" onClick={() => setIssued(undefined)}>Ya lo guardé</Button></div>
        </section>
      ) : null}

      {s && !issued ? (
        <section aria-label="Punto de entrada" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
          {s.configured && s.path ? (
            <>
              <p className="text-[13.5px]"><b>Punto de entrada activo.</b> Creado el {shortDateTime(s.created_at!)}{s.rotated_at ? <>; secreto regenerado el {shortDateTime(s.rotated_at)}</> : null}. {s.last_used_at ? <>Último aviso recibido el {shortDateTime(s.last_used_at)}.</> : 'Aún no ha recibido ningún aviso.'}</p>
              <CopyField label="URL del punto de entrada" value={full(s.path)} />
              {confirm ? (
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span>¿Regenerar el secreto? El actual dejará de funcionar.</span>
                  <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" loading={issue.isPending} onClick={generate}>Sí, regenerar</Button>
                  <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirm(false)}>No</Button>
                </div>
              ) : <div><Button onClick={() => setConfirm(true)}>Regenerar secreto</Button></div>}
            </>
          ) : (
            <>
              <p className="text-[13.5px]">Aún no hay un punto de entrada. Genera uno para conectar GoHighLevel.</p>
              <div><Button variant="primary" loading={issue.isPending} onClick={generate}>Generar punto de entrada</Button></div>
            </>
          )}
        </section>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}

      <section aria-label="Cómo conectarlo" className="grid gap-2 rounded-2xl border border-line bg-surface p-4 text-[13.5px]">
        <h2 className="text-[15px] font-bold">Cómo conectarlo en GoHighLevel</h2>
        <ol className="grid list-decimal gap-1 pl-5">
          <li>En el flujo de trabajo que se activa cuando entra un contacto por Click-to-WhatsApp, agrega la acción «Webhook» (método POST).</li>
          <li>Pega la URL del punto de entrada.</li>
          <li>Agrega la cabecera <code className="rounded bg-surface2 px-1">X-Webhook-Secret</code> con el secreto.</li>
          <li>Envía este cuerpo JSON con los datos del contacto y del anuncio:</li>
        </ol>
        <pre className="overflow-x-auto rounded-xl bg-surface2 p-3 text-[12.5px]">{EXAMPLE}</pre>
        <p className="text-muted">Si el contacto ya existe (mismo teléfono), solo se le agrega el origen. El primer clic nunca se sobrescribe; cada clic nuevo actualiza el último.</p>
      </section>
    </div>
  );
}
