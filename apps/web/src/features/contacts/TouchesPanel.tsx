import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import { Alert, Spinner } from '../../ui/controls';

export type TouchKind = 'ad_click' | 'form_submit' | 'message_in';
export interface Touch {
  id: string;
  at: string;
  kind: TouchKind;
  source: string;
  campaign: string | null;
  adset: string | null;
  ad: string | null;
  ad_id: string | null;
  headline: string | null;
  source_url: string | null;
  utm: Record<string, string>;
}

const KIND_LABEL: Record<TouchKind, string> = { ad_click: 'Clic a un anuncio', form_submit: 'Envió un formulario', message_in: 'Primer mensaje' };
const when = (iso: string): string => new Date(iso).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });

export function useTouches(contactId: string) {
  return useQuery({ queryKey: ['contact-touches', contactId], retry: false, queryFn: () => api<{ items: Touch[] }>(`/contacts/${contactId}/touches`) });
}

/** Solo direcciones https: lo demás no se vuelve enlace (el servidor ya las filtra; esto es un cinturón más). */
const safeHref = (u: string | null): string | null => (u && /^https:\/\/\S+$/.test(u) ? u : null);

function Row({ t }: { t: Touch }) {
  const detail = [t.campaign && `Campaña: ${t.campaign}`, t.adset && `Conjunto: ${t.adset}`, t.ad && `Anuncio: ${t.ad}`].filter(Boolean) as string[];
  const utm = Object.entries(t.utm).map(([k, v]) => `${k}=${v}`);
  const href = safeHref(t.source_url);
  return (
    <li className="grid gap-0.5 py-3 text-[13px]">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold">{KIND_LABEL[t.kind]}</span>
        <span className="text-muted">{when(t.at)}</span>
      </div>
      {t.headline ? <span>{t.headline}</span> : null}
      {detail.length > 0 ? <span className="text-muted">{detail.join(' · ')}</span> : null}
      {utm.length > 0 ? <span className="text-[12px] text-muted">{utm.join(' · ')}</span> : null}
      {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-[12.5px] text-accent underline">Ver la publicación</a> : null}
    </li>
  );
}

/**
 * «Actividad» del contacto (M6.6, ADR-55): de dónde llegó y cada vez que volvió a entrar (clics de anuncio, formularios y primer mensaje), del más reciente al más antiguo. Solo lectura;
 * el servidor aplica el alcance por persona.
 */
export function TouchesPanel({ contactId }: { contactId: string }) {
  const q = useTouches(contactId);
  if (q.isPending) return <div className="grid place-items-center py-8 text-muted"><Spinner label="Cargando la actividad" /></div>;
  if (q.isError) return <Alert>{friendlyError(q.error, 'No se pudo cargar la actividad')}</Alert>;
  if (q.data.items.length === 0) return <p className="py-6 text-center text-[13.5px] text-muted">Todavía no hay actividad de origen registrada para este contacto.</p>;
  return <ul aria-label="Actividad de origen" className="divide-y divide-line">{q.data.items.map((t) => <Row key={t.id} t={t} />)}</ul>;
}
