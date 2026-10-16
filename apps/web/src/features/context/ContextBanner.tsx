import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { friendlyError } from '../../lib/errors';
import { ACCESS_LEVEL_LABEL } from '../../lib/format';
import { useSession } from '../../lib/session';
import type { Me } from '../../lib/types';
import { Button } from '../../ui/controls';
import { SwitchClientDialog } from './SwitchClientDialog';

/**
 * Banner permanente cuando se está DENTRO de una organización que no es la propia (ADR-21/41): «Administrando X» para una agencia y «Soporte» para el
 * Súper Admin. Recuerda el nivel (o el solo lectura) y ofrece volver al origen sin cerrar sesión; la agencia también puede cambiar de cliente.
 * Es solo presentación: lo que la persona puede hacer lo decide el servidor en cada petición.
 */
export function ContextBanner({ me }: { me: Me }) {
  const { switchContext } = useSession();
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string>();
  if (!me.acting_as) return null;

  const agency = me.acting_as === 'agency';
  const back = me.home.kind === 'agency' ? 'Volver a mi agencia' : me.home.kind === 'platform' ? 'Volver a la plataforma' : 'Volver';

  async function leave() {
    setError(undefined);
    setLeaving(true);
    try {
      await switchContext(null);
      navigate('/');
    } catch (e) {
      setError(friendlyError(e, 'No pudimos volver. Inténtalo de nuevo.'));
      setLeaving(false);
    }
  }

  return (
    <div role="region" aria-label="Contexto de acceso" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-accent/30 bg-accent-soft px-5 py-2.5 text-[13px]">
      <p className="min-w-0">
        {agency ? <>Administrando <b>{me.organization.name}</b></> : <>Soporte: estás dentro de <b>{me.organization.name}</b></>}
        {agency && me.access_level ? <> · {ACCESS_LEVEL_LABEL[me.access_level]}</> : null}
        {me.read_only && me.access_level !== 'read' ? <> · Solo lectura: la prueba de esta empresa venció</> : null}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {error ? <span role="alert" className="text-crit">{error}</span> : null}
        {agency ? <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setPicking(true)}>Cambiar de cliente</Button> : null}
        <Button variant="primary" className="!px-3 !py-1.5 !text-[12.5px]" loading={leaving} onClick={() => void leave()}>{back}</Button>
      </div>
      {picking ? <SwitchClientDialog onClose={() => setPicking(false)} /> : null}
    </div>
  );
}
