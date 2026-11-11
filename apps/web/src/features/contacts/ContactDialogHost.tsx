import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import type { Contact } from '../../lib/types';
import { Alert, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { ContactDialog } from './ContactDialog';
import type { ContactTab } from './ContactQuickActions';
import { useOwners } from './useContacts';

/**
 * Abre la ficha de un contacto desde fuera de Contactos (las tarjetas del Kanban, v11 S2): pide el contacto completo por su id y, cuando llega, muestra el mismo diálogo en la sección pedida.
 * El servidor ya limita lo que cada persona ve: si no puede, responde 404/403 y se dice aquí. Mismos permisos que la columna de contacto del Inbox.
 */
export function ContactDialogHost({ contactId, tab, onClose }: { contactId: string; tab: ContactTab; onClose: () => void }) {
  const q = useQuery({ queryKey: ['contact', contactId], retry: false, staleTime: 15_000, queryFn: () => api<Contact>(`/contacts/${contactId}`) });
  const owners = useOwners(true);
  if (q.isPending) return <Modal title="Contacto" onClose={onClose}><div className="grid place-items-center py-8 text-muted"><Spinner label="Cargando el contacto" /></div></Modal>;
  if (q.isError) return <Modal title="Contacto" onClose={onClose}><Alert>{friendlyError(q.error, 'No pudimos abrir el contacto.')}</Alert></Modal>;
  return <ContactDialog contact={q.data} owners={owners.data ?? []} canAssign={(owners.data?.length ?? 0) > 0} canDelete={false} readOnly={false} initialTab={tab} onClose={() => { onClose(); void q.refetch(); }} />;
}
