import { useState } from 'react';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { campaignError } from './labels';
import { useAdvisorLimits, useCampaignAccess, useSetAdvisorLimit } from './useCampaigns';

/**
 * «Campañas masivas» en la ficha de un asesor (Equipo › Usuarios): su tope diario de mensajes de campaña. Va aquí y no en Configuración porque así lo hace el prototipo (el tope es un dato de la
 * persona, junto a su horario). Solo lo ve quien administra al equipo y solo si el plan de la empresa incluye campañas. Sin tope propio rige el de la conexión. El permiso de enviar campañas se
 * concede en la pestaña «Permisos».
 */
export function CampaignLimitSection({ userId, role, active }: { userId: string; role: string; active: boolean }) {
  const access = useCampaignAccess().data;
  const show = access?.plan_enabled === true && access.manage_limits && role === 'advisor';
  const limits = useAdvisorLimits(show);
  const set = useSetAdvisorLimit(userId);
  const saved = limits.data?.items.find((i) => i.user_id === userId)?.daily_cap ?? null;
  // Lo escrito hasta que se guarda; mientras no se toque, se muestra lo guardado
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  if (!show) return null;
  const value = draft ?? (saved === null ? '' : String(saved));

  const cap = Number(value);
  const valid = Number.isInteger(cap) && cap >= 1 && cap <= 10000;
  const save = (): void => {
    setNote(undefined);
    setError(undefined);
    if (!valid) return setError('Escribe un número entero entre 1 y 10 000.');
    set.mutate(cap, { onSuccess: () => { setDraft(null); setNote('Tope guardado.'); }, onError: (e) => setError(campaignError(e, 'No pudimos guardar el tope.')) });
  };

  return (
    <section className="grid gap-2 rounded-2xl border border-line p-4" aria-label="Campañas masivas">
      <b className="text-[13.5px]">Campañas masivas</b>
      <p className="text-[12px] text-muted">Tope diario de mensajes de campaña de esta persona. Nunca supera el límite de la conexión. Sin tope propio rige solo el de la conexión. Para que pueda enviar campañas, actívaselo en la pestaña «Permisos».</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-[180px]">
          <Field label="Tope diario">{(f) => <Input {...f} type="number" inputMode="numeric" min={1} max={10000} value={value} disabled={!active} placeholder={saved === null ? 'Sin tope propio' : ''} onChange={(e) => setDraft(e.target.value)} />}</Field>
        </div>
        <Button loading={set.isPending} disabled={!active || value === '' || value === String(saved)} onClick={save}>Guardar tope</Button>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {note ? <Alert kind="ok">{note}</Alert> : null}
    </section>
  );
}
