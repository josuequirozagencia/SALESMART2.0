import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { friendlyError } from '../../lib/errors';
import { ACCESS_LEVEL_LABEL } from '../../lib/format';
import { useSession } from '../../lib/session';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { useContextOptions } from './useContextOptions';

/**
 * «Cambiar de cliente» (F02): el selector con buscador de la agencia. Lista solo los clientes a los que la persona tiene acceso vigente (el
 * servidor decide); entrar no cierra la sesión. Si el acceso se quitó mientras tanto, el servidor responde 404 y aquí se avisa sin revelar más.
 */
export function SwitchClientDialog({ onClose }: { onClose: () => void }) {
  const { switchContext } = useSession();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const [entering, setEntering] = useState<string>();
  const [error, setError] = useState<string>();
  const options = useContextOptions(term);

  // Búsqueda con espera: no se consulta en cada tecla
  useEffect(() => {
    const t = setTimeout(() => setTerm(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  async function enter(id: string) {
    setError(undefined);
    setEntering(id);
    try {
      await switchContext(id);
      onClose();
      navigate('/');
    } catch (e) {
      setError(friendlyError(e, 'Ya no tienes acceso a ese cliente. Actualizamos la lista.'));
      void options.refetch();
    } finally {
      setEntering(undefined);
    }
  }

  const items = options.data?.items ?? [];
  return (
    <Modal title="Cambiar de cliente" onClose={onClose}>
      <label className="grid gap-1 text-[12px] font-semibold">Buscar cliente
        <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Nombre del cliente" autoFocus className="w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal" />
      </label>
      {options.isPending ? <div className="grid place-items-center py-6 text-muted"><Spinner label="Cargando clientes" /></div> : null}
      {options.isError ? <Alert>{friendlyError(options.error, 'No pudimos cargar tus clientes.')}</Alert> : null}
      {options.isSuccess && items.length === 0 ? <p className="rounded-xl border border-dashed border-line p-4 text-center text-[13px] text-muted">{term ? 'Ningún cliente coincide con la búsqueda.' : 'No tienes otros clientes a los que entrar.'}</p> : null}
      {items.length > 0 ? (
        <ul className="grid max-h-[320px] gap-1.5 overflow-y-auto" aria-label="Clientes">
          {items.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2">
              <span className="min-w-0">
                <b className="block truncate text-[13.5px]">{c.name}</b>
                {c.access_level ? <span className="mt-0.5 inline-block"><Pill kind="muted">{ACCESS_LEVEL_LABEL[c.access_level]}</Pill></span> : null}
              </span>
              <Button variant="primary" className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Entrar a ${c.name}`} loading={entering === c.id} disabled={entering !== undefined} onClick={() => void enter(c.id)}>Entrar</Button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end"><Button onClick={onClose}>Cerrar</Button></div>
    </Modal>
  );
}
