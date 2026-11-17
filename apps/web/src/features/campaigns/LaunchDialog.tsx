import { Alert, Button } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { campaignError, KIND_TITLE } from './labels';
import { useIdempotencyKey, useLaunchCampaign, type Campaign, type CampaignPreview } from './useCampaigns';

/**
 * La confirmación antes de enviar (v17 · 17.3): un envío masivo no se deshace, así que se dice qué va a pasar —a cuántas personas, por qué conexión, a qué ritmo, el costo de las plantillas de
 * marketing y que quien pidió la baja nunca recibe nada— y solo entonces se lanza. El servidor vuelve a calcular la audiencia al lanzar (esto es la estimación de la vista previa).
 */
export function LaunchDialog({ campaign, preview, templateName, onClose, onLaunched }: { campaign: Campaign; preview: CampaignPreview | undefined; templateName: string | null; onClose: () => void; onLaunched: (c: Campaign) => void }) {
  const launch = useLaunchCampaign();
  const idem = useIdempotencyKey();
  const later = campaign.scheduled_at !== null;
  const eligible = preview?.audience.eligible ?? 0;
  const limits = preview?.limits ?? null;
  const days = preview?.estimate?.days ?? 1;
  const confirm = (): void => {
    launch.mutate({ id: campaign.id, key: idem.keyFor(campaign.id) }, { onSuccess: (c) => { idem.reset(); onLaunched(c); } });
  };
  return (
    <Modal title={later ? 'Programar campaña' : 'Enviar campaña'} onClose={onClose} wide>
      <p className="text-[13.5px]">
        «<b>{campaign.name}</b>» se {later ? 'programará' : 'enviará'} a <b>{eligible}</b> {eligible === 1 ? 'destinatario' : 'destinatarios'} por {campaign.channel ? <b>{campaign.channel.name}</b> : 'la conexión elegida'}
        {templateName ? <> con la plantilla <b>{templateName}</b></> : null}.
      </p>
      <ul className="grid list-disc gap-1 pl-5 text-[13px] text-muted">
        {later ? <li>Saldrá el <b className="text-fg">{new Date(campaign.scheduled_at!).toLocaleString('es-EC', { dateStyle: 'full', timeStyle: 'short' })}</b>.</li> : null}
        <li>Un mensaje cada {campaign.gap_seconds} segundos{limits ? `, hasta ${limits.daily_cap} por día${days > 1 ? ` (tardará ${days} días)` : ''}` : ''}.</li>
        {preview?.warnings.includes('official_marketing_cost') ? <li>Las plantillas de marketing tienen costo en Meta: se estiman {eligible} mensajes.</li> : null}
        <li>Quien pidió la baja o no dio su consentimiento no recibe nada. Puedes pausarla o cancelarla cuando quieras: lo que ya salió queda.</li>
        {campaign.channel ? <li>Conexión: {KIND_TITLE[campaign.channel.kind]}.</li> : null}
      </ul>
      {launch.isError ? <Alert>{campaignError(launch.error, 'No pudimos lanzar la campaña.')}</Alert> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onClose} disabled={launch.isPending}>Volver</Button>
        <Button variant="primary" loading={launch.isPending} onClick={confirm}>{later ? 'Programar campaña' : 'Confirmar y enviar'}</Button>
      </div>
    </Modal>
  );
}
