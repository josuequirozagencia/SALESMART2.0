import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import { initials, money, shortDateTime } from '../../lib/format';
import type { Contact, Conversation } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { AttributionSection } from '../contacts/AttributionSection';
import { customText } from '../contacts/columns';
import { ContactDialog } from '../contacts/ContactDialog';
import { useOwners } from '../contacts/useContacts';
import { NotesPanel } from '../crm/NotesPanel';
import { TasksPanel } from '../crm/TasksPanel';
import { useCustomFields } from '../custom-fields/useCustomFields';
import { ContactOpportunitiesPanel } from '../pipelines/ContactOpportunitiesPanel';
import { GhlFlowsDialog } from '../ghl/GhlFlowsPanel';
import { AppointmentDialog } from '../appointments/AppointmentDialog';
import { SaleDialog } from '../sales/SaleDialog';
import type { Appointment } from '../appointments/useAppointments';
import type { Sale } from '../sales/useSales';

const CONSENT: Record<Contact['consent'], string> = { unknown: 'Consentimiento sin definir', granted: 'Con consentimiento', revoked: 'Retiró el consentimiento' };

/** El contacto completo (con campos personalizados, empresas y origen). El servidor ya limita lo que cada persona ve: si no puede, responde 404/403 y el panel lo dice. */
function useContactDetail(id: string) {
  return useQuery({ queryKey: ['contact', id], retry: false, staleTime: 15_000, queryFn: () => api<Contact>(`/contacts/${id}`) });
}

/** La próxima cita agendada del contacto (la más cercana en el futuro). Sin permiso de agenda, no aparece. */
function useNextAppointment(contactId: string) {
  return useQuery({
    queryKey: ['appointments', 'contact', contactId],
    retry: false,
    staleTime: 15_000,
    queryFn: async (): Promise<Appointment | null> => {
      const from = new Date().toISOString();
      const to = new Date(Date.now() + 60 * 86_400_000).toISOString();
      const r = await api<{ items: Appointment[] }>(`/appointments?contact_id=${contactId}&status=scheduled&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      return [...r.items].sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0] ?? null;
    },
  });
}

/** Las últimas ventas del contacto. Sin permiso de ventas, no aparecen. */
function useContactSales(contactId: string) {
  return useQuery({ queryKey: ['sales', 'contact', contactId], retry: false, staleTime: 15_000, queryFn: () => api<{ items: Sale[] }>(`/sales?contact_id=${contactId}&limit=3`) });
}

function Block({ title, children, open }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <section aria-label={title} className="grid gap-2 border-b border-line px-4 py-3">
      <h3 className={`text-[12px] font-bold uppercase tracking-wide text-muted ${open === false ? 'sr-only' : ''}`}>{title}</h3>
      {children}
    </section>
  );
}

/** Una sección que solo trae sus datos cuando se abre (notas y tareas pueden ser largas). */
function Lazy({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label={title} className="border-b border-line">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex min-h-[44px] w-full items-center justify-between gap-2 px-4 text-left text-[12px] font-bold uppercase tracking-wide text-muted">
        {title}
        <span aria-hidden="true" className={`transition ${open ? 'rotate-180' : ''}`}>⌄</span>
      </button>
      {open ? <div className="px-4 pb-3">{children}</div> : null}
    </section>
  );
}

/**
 * Acciones de la conversación sobre el contacto: agendar una cita, registrar una venta e inscribirlo en un flujo de GoHighLevel. Las pide quien atiende la conversación (su dueño o
 * quien ve todo) —las mismas reglas que tenían en la cabecera—; el servidor vuelve a verificarlas.
 */
function ConversationActions({ c }: { c: Conversation }) {
  const [sale, setSale] = useState(false);
  const [appointment, setAppointment] = useState(false);
  const [flows, setFlows] = useState(false);
  const can = c.owner !== null && (c.my_access === 'owner' || c.my_access === 'supervisor');
  if (!can) return null;
  return (
    <Block title="Acciones">
      <div className="flex flex-wrap gap-2">
        <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setAppointment(true)}>Agendar</Button>
        <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setSale(true)}>Registrar venta</Button>
        {c.channel.kind === 'ghl' ? <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setFlows(true)}>Inscribir en un flujo</Button> : null}
      </div>
      {appointment ? <AppointmentDialog c={c} onClose={() => setAppointment(false)} /> : null}
      {flows ? <GhlFlowsDialog contact={c.contact} onClose={() => setFlows(false)} /> : null}
      {sale ? <SaleDialog c={c} onClose={() => setSale(false)} /> : null}
    </Block>
  );
}

/**
 * Columna de datos del contacto en el Inbox (M5.8, Build Spec ADR-157): arranca oculta; se abre con el botón «Datos del contacto» o pulsando su nombre. Junta lo que ya existe en
 * la ficha —datos, origen del lead, campos personalizados, oportunidades abiertas, próxima cita, últimas ventas, notas y tareas— SIN pedir nada nuevo al servidor: cada bloque
 * usa la misma API (y los mismos permisos) que su pantalla; lo que la persona no puede ver, el servidor no lo devuelve y el bloque no aparece.
 */
export function ContactSidebar({ c, onClose }: { c: Conversation; onClose: () => void }) {
  const q = useContactDetail(c.contact.id);
  const fields = useCustomFields();
  const appt = useNextAppointment(c.contact.id);
  const sales = useContactSales(c.contact.id);
  const owners = useOwners(true);
  const [editing, setEditing] = useState(false);
  const contact = q.data;
  const canAssign = (owners.data?.length ?? 0) > 0;
  const defs = fields.data?.items ?? [];
  const filled = contact ? defs.filter((d) => d.archived_at === null && contact.custom_fields[d.key] !== undefined) : [];

  return (
    <aside aria-label="Datos del contacto" className="flex min-h-0 w-full flex-col overflow-y-auto border-l border-line bg-surface">
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-full bg-surface2 text-[14px] font-bold text-muted">{initials(c.contact.name)}</span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-bold">{c.contact.name}</h2>
          <p className="truncate text-[12.5px] text-muted">{c.contact.phone ?? 'Sin teléfono'}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Cerrar los datos del contacto" className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface2">✕</button>
      </div>

      <ConversationActions c={c} />

      {q.isPending ? <div className="grid place-items-center py-8 text-muted"><Spinner label="Cargando el contacto" /></div> : null}
      {q.isError ? <div className="p-4"><Alert>{friendlyError(q.error, 'No pudimos cargar los datos del contacto.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert></div> : null}

      {contact ? (
        <>
          <Block title="Contacto">
            <dl className="grid gap-1.5 text-[13px]">
              <div><dt className="text-[12px] text-muted">Teléfonos</dt><dd>{contact.phones.length > 0 ? contact.phones.map((p) => p.e164 + (p.primary && contact.phones.length > 1 ? ' (principal)' : '')).join(' · ') : '—'}</dd></div>
              {contact.email ? <div><dt className="text-[12px] text-muted">Correo</dt><dd className="break-all">{contact.email}</dd></div> : null}
              <div><dt className="text-[12px] text-muted">Responsable</dt><dd>{contact.owner?.name ?? 'Sin responsable'}</dd></div>
              <div><dt className="text-[12px] text-muted">Consentimiento</dt><dd>{CONSENT[contact.consent]}</dd></div>
              {contact.companies.length > 0 ? <div><dt className="text-[12px] text-muted">Empresas</dt><dd>{contact.companies.map((x) => x.name).join(', ')}</dd></div> : null}
            </dl>
            <div className="flex flex-wrap gap-1.5">{c.tags.map((t) => <span key={t.id} className="rounded px-1.5 py-0.5 text-[10.5px] font-semibold text-white" style={{ backgroundColor: t.color }}>{t.name}</span>)}</div>
            <div className="flex flex-wrap gap-2">
              <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setEditing(true)}>Editar contacto</Button>
              <Link to="/contacts" className="inline-flex items-center rounded-[10px] border border-line px-3 py-1.5 text-[12.5px] font-semibold hover:bg-surface2">Ver en Contactos</Link>
            </div>
          </Block>

          {contact.attribution ? <div className="border-b border-line px-4 py-3"><AttributionSection contact={contact} /></div> : null}

          {filled.length > 0 ? (
            <Block title="Campos personalizados">
              <dl className="grid gap-1.5 text-[13px]">
                {filled.map((d) => <div key={d.id}><dt className="text-[12px] text-muted">{d.name}</dt><dd className="break-words">{customText(d, contact.custom_fields[d.key])}</dd></div>)}
              </dl>
            </Block>
          ) : null}

          <Block title="Próxima cita">
            {appt.isPending ? <Spinner label="Cargando la cita" /> : appt.data ? (
              <p className="text-[13px]"><b>{shortDateTime(appt.data.starts_at)}</b> · {appt.data.kind}<span className="block text-[12px] text-muted">{appt.data.owner?.name ?? 'Sin responsable'} · {appt.data.duration_minutes} min</span></p>
            ) : <p className="text-[13px] text-muted">{appt.isError ? 'No tienes acceso a la agenda.' : 'No tiene citas próximas.'}</p>}
          </Block>

          <Block title="Últimas ventas">
            {sales.isPending ? <Spinner label="Cargando las ventas" /> : (sales.data?.items.length ?? 0) > 0 ? (
              <ul className="grid gap-1.5">
                {sales.data!.items.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 text-[13px]">
                    <span className="min-w-0 truncate">{s.product.name}<span className="block text-[12px] text-muted">{shortDateTime(s.created_at)}</span></span>
                    <span className="flex shrink-0 items-center gap-1.5"><span className="font-mono font-semibold">{money(s.amount, s.currency)}</span>{s.status === 'cancelled' ? <Pill kind="crit">Anulada</Pill> : s.collected ? <Pill kind="ok">Cobrada</Pill> : <Pill kind="warn">Saldo {money(s.balance, s.currency)}</Pill>}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-[13px] text-muted">{sales.isError ? 'No tienes acceso a las ventas.' : 'Aún no tiene ventas.'}</p>}
          </Block>

          <Lazy title="Oportunidades"><ContactOpportunitiesPanel contact={contact} canWrite viewAll={canAssign} owners={owners.data ?? []} /></Lazy>
          <Lazy title="Notas"><NotesPanel target={{ kind: 'contact', id: contact.id }} canWrite /></Lazy>
          <Lazy title="Tareas"><TasksPanel link={{ contact: { id: contact.id, name: contact.name } }} canWrite viewAll={canAssign} owners={owners.data ?? []} /></Lazy>
          {editing ? <ContactDialog contact={contact} owners={owners.data ?? []} canAssign={canAssign} canDelete={false} readOnly={false} onClose={() => { setEditing(false); void q.refetch(); }} /> : null}
        </>
      ) : null}
    </aside>
  );
}
