import { useState } from 'react';
import { Alert, Button } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { campaignError, KIND_TITLE } from './labels';
import { useIdempotencyKey, useLaunchCampaign, type Campaign, type CampaignPreview } from './useCampaigns';

/**
 * La confirmación antes de enviar (v17 · 17.3 y 17.4): un envío masivo no se deshace, así que se dice qué va a pasar —a cuántas personas, por qué conexión, a qué ritmo, el costo de las plantillas de
 * marketing y que quien pidió la baja nunca recibe nada— y solo entonces se lanza. Por WhatsApp QR (no oficial) hay además un aviso de riesgo que se tiene que aceptar: queda registrado. El servidor
 * vuelve a calcular la audiencia al lanzar (esto es la estimación de la vista previa).
 */
export function LaunchDialog({ campaign, preview, templateName, onClose, onLaunched }: { campaign: Campaign; preview: CampaignPreview | undefined; templateName: string | null; onClose: () => void; onLaunched: (c: Campaign) => void }) {
  const launch = useLaunchCampaign();
  const idem = useIdempotencyKey();
  const [accepted, setAccepted] = useState(false);
  const later = campaign.scheduled_at !== null;
  const qr = campaign.channel?.kind === 'qr';
  const eligible = preview?.audience.eligible ?? 0;
  const limits = preview?.limits ?? null;
  const days = preview?.estimate?.days ?? 1;
  const confirm = (): void => {
    launch.mutate({ id: campaign.id, key: idem.keyFor(campaign.id), acceptQrRisk: qr && accepted }, { onSuccess: (c) => { idem.reset(); onLaunched(c); } });
  };
  return (
    <Modal title={later ? 'Programar campaña' : 'Enviar campaña'} onClose={onClose} wide>
      <p className="text-[13.5px]">
        «<b>{campaign.name}</b>» se {later ? 'programará' : 'enviará'} a <b>{eligible}</b> {eligible === 1 ? 'destinatario' : 'destinatarios'} por {campaign.channel ? <b>{campaign.channel.name}</b> : 'la conexión elegida'}
        {templateName ? <> con la plantilla <b>{templateName}</b></> : qr ? <> con el mensaje que escribiste</> : null}.
      </p>
      <ul className="grid list-disc gap-1 pl-5 text-[13px] text-muted">
        {later ? <li>Saldrá el <b className="text-fg">{new Date(campaign.scheduled_at!).toLocaleString('es-EC', { dateStyle: 'full', timeStyle: 'short' })}</b>.</li> : null}
        <li>Un mensaje cada {campaign.gap_seconds} segundos{limits ? `, hasta ${limits.daily_cap} por día${days > 1 ? ` (tardará ${days} días)` : ''}` : ''}.</li>
        {preview?.warnings.includes('official_marketing_cost') ? <li>Las plantillas de marketing tienen costo en Meta: se estiman {eligible} mensajes.</li> : null}
        {qr ? <li>La campaña usa como máximo el 70 % del cupo diario del número: el resto queda para tus conversaciones.</li> : null}
        {qr && campaign.body_variants.length > 0 ? <li>Cada contacto recibirá una de las {campaign.body_variants.length + 1} versiones del mensaje.</li> : null}
        <li>Quien pidió la baja o no dio su consentimiento no recibe nada. Puedes pausarla o cancelarla cuando quieras: lo que ya salió queda.</li>
        {campaign.channel ? <li>Conexión: {KIND_TITLE[campaign.channel.kind]}.</li> : null}
      </ul>
      {qr ? (
        <div className="grid gap-2 rounded-xl bg-warn-soft px-3 py-2.5 text-[13px] text-warn">
          <p><b>Conexión no oficial.</b> WhatsApp puede bloquear un número que envía muchos mensajes seguidos. Envía un texto natural, no repitas el mismo mensaje a cientos de personas y no lo hagas con un número que no puedas perder.</p>
          <label className="flex items-start gap-2 font-semibold">
            <input type="checkbox" className="mt-0.5 size-[18px] accent-[var(--accent)]" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            <span>Entiendo el riesgo y quiero enviar por WhatsApp QR.</span>
          </label>
        </div>
      ) : null}
      {launch.isError ? <Alert>{campaignError(launch.error, 'No pudimos lanzar la campaña.')}</Alert> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onClose} disabled={launch.isPending}>Volver</Button>
        <Button variant="primary" loading={launch.isPending} disabled={qr && !accepted} onClick={confirm}>{later ? 'Programar campaña' : 'Confirmar y enviar'}</Button>
      </div>
    </Modal>
  );
}
