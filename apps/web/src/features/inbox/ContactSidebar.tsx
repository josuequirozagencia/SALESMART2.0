import { useQuery } from '@tanstack/react-query';
import { Avatar } from '../../ui/Avatar';
import { usePhotos } from '../photos/usePhotos';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Icon } from '../../ui/Icon';
import { friendlyError } from '../../lib/errors';
import { money, shortDateTime } from '../../lib/format';
import type { Contact, Conversation } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { ConversationTags } from './ConversationTags';
import { AgentPanelBlock } from './AgentBanner';
import { ActionTiles, DangerRows, PrimaryActions } from './ConversationActions';
import { personName } from './inboxFormat';
import { SlaPill } from './SlaPill';
import { useNow } from '../../lib/useNow';
import { Tile } from './SheetButton';
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

/** Qué bloques de la columna están plegados, por persona y empresa, en este navegador (`ss.contactblocks.v1:<userId>:<orgId>`; sin endpoint). Todo acceso al almacenamiento va en try/catch. */
const blocksKey = (userId: string, orgId: string): string => `ss.contactblocks.v1:${userId}:${orgId}`;
function readBlocks(key: string | null): Record<string, boolean> {
  if (!key) return {};
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(key) ?? '{}');
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'boolean')) as Record<string, boolean>;
  } catch {
    return {};
  }
}
interface BlockState {
  isOpen: (id: string, byDefault: boolean) => boolean;
  toggle: (id: string, byDefault: boolean) => void;
  open: (id: string) => void;
}
function useBlockState(): BlockState {
  const { state } = useSession();
  const key = state.status === 'authed' ? blocksKey(state.me.user.id, state.me.organization.id) : null;
  // Lo elegido en esta sesión de la página; si cambia la persona o la empresa (otra clave) se vuelve a leer del almacenamiento
  const [mine, setMine] = useState<{ key: string | null; data: Record<string, boolean> } | null>(null);
  const saved = mine !== null && mine.key === key ? mine.data : readBlocks(key);
  const write = (next: Record<string, boolean>): void => {
    setMine({ key, data: next });
    if (!key) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* sin almacenamiento: vale mientras la página siga abierta */
    }
  };
  return {
    isOpen: (id, byDefault) => saved[id] ?? byDefault,
    toggle: (id, byDefault) => write({ ...saved, [id]: !(saved[id] ?? byDefault) }),
    open: (id) => write({ ...saved, [id]: true }),
  };
}

/** Un bloque de la columna: título claro, plegable (el estado se recuerda por persona). `lazy`: solo monta su contenido —y pide sus datos— cuando se abre. */
function Block({ id, title, st, byDefault = true, children }: { id: string; title: string; st: BlockState; byDefault?: boolean; children: ReactNode }) {
  const open = st.isOpen(id, byDefault);
  return (
    <section id={`cs-${id}`} aria-label={title} className="border-b border-line">
      <button type="button" aria-expanded={open} onClick={() => st.toggle(id, byDefault)} className="flex min-h-11 w-full items-center justify-between gap-2 px-4 text-left text-[12px] font-bold uppercase tracking-wide text-muted hover:bg-surface2">
        {title}
        <Icon name="chevronRight" size={16} className={`shrink-0 transition ${open ? 'rotate-90' : ''}`} />
      </button>
      {open ? <div className="grid gap-2 px-4 pb-3">{children}</div> : null}
    </section>
  );
}

/**
 * Acciones rápidas de la cabecera. «Registrar venta» y «Agendar» (y el flujo de GoHighLevel) las pide quien atiende la conversación (su dueño o quien ve todo) —las mismas reglas
 * que tenían en la cabecera—; el servidor vuelve a verificarlas. «Editar», «Notas» y «Tareas» abren el diálogo o el bloque que ya existe en esta columna (sin llamadas: la telefonía aún no está construida).
 */
function QuickActions({ c, onEdit, onGoto, canEdit, lead, extraTiles }: { c: Conversation; onEdit: () => void; onGoto: (block: string) => void; canEdit: boolean; lead?: ReactNode; extraTiles?: ReactNode }) {
  const [sale, setSale] = useState(false);
  const [appointment, setAppointment] = useState(false);
  const [flows, setFlows] = useState(false);
  const can = c.owner !== null && (c.my_access === 'owner' || c.my_access === 'supervisor');
  return (
    <div className="grid gap-2 border-b border-line px-4 py-3">
      {lead}
      {can ? <Button variant="primary" className="w-full justify-center" onClick={() => setSale(true)}>Registrar venta</Button> : null}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {can ? <Tile icon="calendar" label="Agendar" onClick={() => setAppointment(true)} /> : null}
        {canEdit ? <Tile icon="pen" label="Editar" onClick={onEdit} /> : null}
        <Tile icon="list" label="Ir a notas" onClick={() => onGoto('notes')} />
        <Tile icon="check" label="Ir a tareas" onClick={() => onGoto('tasks')} />
        {extraTiles}
      </div>
      {can && c.channel.kind === 'ghl' ? <Button className="w-full justify-center !px-3 !py-1.5 !text-[12.5px]" onClick={() => setFlows(true)}>Inscribir en un flujo</Button> : null}
      {appointment ? <AppointmentDialog c={c} onClose={() => setAppointment(false)} /> : null}
      {flows ? <GhlFlowsDialog contact={c.contact} onClose={() => setFlows(false)} /> : null}
      {sale ? <SaleDialog c={c} onClose={() => setSale(false)} /> : null}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = { unassigned: 'Sin asignar', pending: 'Pendiente', working: 'Trabajando', waiting: 'Esperando al cliente', closed: 'Finalizada' };

/**
 * Columna de datos del contacto en el Inbox (M5.8; rediseño v6 fase D según el prototipo v10): cabecera con foto, nombre, teléfono y estado; acciones rápidas; y bloques plegables
 * —Datos, Etiquetas, Origen, Campos personalizados, Próxima cita, Oportunidades, Últimas ventas, Notas y Tareas— cuyo estado plegado se recuerda por persona. SIN pedir nada nuevo al
 * servidor: cada bloque usa la misma API (y los mismos permisos) que su pantalla; lo que la persona no puede ver, el servidor no lo devuelve y el bloque lo dice o no aparece.
 */
export function ContactSidebar({ c, onClose, actions }: { c: Conversation; onClose: () => void; actions?: { meId: string; onError: (m: string | undefined) => void } }) {
  const photos = usePhotos([c.contact.id], []);
  const now = useNow(30_000);
  const q = useContactDetail(c.contact.id);
  const fields = useCustomFields();
  const appt = useNextAppointment(c.contact.id);
  const sales = useContactSales(c.contact.id);
  const owners = useOwners(true);
  const st = useBlockState();
  const [editing, setEditing] = useState(false);
  const contact = q.data;
  const canAssign = (owners.data?.length ?? 0) > 0;
  const defs = fields.data?.items ?? [];
  const filled = contact ? defs.filter((d) => d.archived_at === null && contact.custom_fields[d.key] !== undefined) : [];
  // «Ir a notas» y «Ir a tareas» de la cabecera: abren el bloque (si estaba plegado) y lo ponen a la vista
  const goto = (block: string): void => {
    st.open(block);
    window.setTimeout(() => document.getElementById(`cs-${block}`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }), 0);
  };

  return (
    <aside aria-label="Datos del contacto" className="flex min-h-0 w-full flex-col overflow-y-auto border-l border-line bg-surface">
      <div className="relative grid justify-items-center gap-1 border-b border-line px-4 pb-3 pt-4 text-center">
        <button type="button" onClick={onClose} aria-label="Cerrar los datos del contacto" className="absolute right-2 top-2 grid size-12 place-items-center rounded-full bg-surface2 text-fg hover:bg-line"><Icon name="close" size={26} strokeWidth={2.4} /></button>
        <Avatar name={c.contact.name} src={photos.contact(c.contact.id)} size={64} />
        <h2 className="max-w-full truncate text-[15px] font-bold">{c.contact.name}</h2>
        <p className="max-w-full truncate font-mono text-[12.5px] text-muted">{c.contact.phone ?? 'Sin teléfono'}</p>
        <div className="flex flex-wrap justify-center gap-1.5">
          <Pill kind="accent">{c.channel.name}</Pill>
          <Pill kind={c.status === 'closed' ? 'muted' : c.status === 'pending' || c.status === 'unassigned' ? 'warn' : 'ok'}>{STATUS_LABEL[c.status] ?? c.status}</Pill>
          {actions ? <SlaPill sla={c.sla} now={now} /> : null}
        </div>
      </div>

      {actions ? <AgentPanelBlock c={c} /> : null}

      <QuickActions
        c={c}
        canEdit={contact !== undefined}
        onEdit={() => setEditing(true)}
        onGoto={goto}
        {...(actions ? { lead: <PrimaryActions c={c} onClose={onClose} onError={actions.onError} />, extraTiles: <ActionTiles c={c} onClose={onClose} /> } : {})}
      />

      {q.isPending ? <div className="grid place-items-center py-8 text-muted"><Spinner label="Cargando el contacto" /></div> : null}
      {q.isError ? <div className="p-4"><Alert>{friendlyError(q.error, 'No pudimos cargar los datos del contacto.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert></div> : null}

      {contact ? (
        <>
          <Block id="data" title="Datos" st={st}>
            <dl className="grid gap-1.5 text-[13px]">
              <div><dt className="text-[12px] text-muted">Teléfonos</dt><dd>{contact.phones.length > 0 ? contact.phones.map((p) => p.e164 + (p.primary && contact.phones.length > 1 ? ' (principal)' : '')).join(' · ') : '—'}</dd></div>
              {contact.email ? <div><dt className="text-[12px] text-muted">Correo</dt><dd className="break-all">{contact.email}</dd></div> : null}
              <div><dt className="text-[12px] text-muted">Responsable</dt><dd>{contact.owner ? personName(contact.owner.name) : 'Sin responsable'}</dd></div>
              <div><dt className="text-[12px] text-muted">Consentimiento</dt><dd>{CONSENT[contact.consent]}</dd></div>
              {contact.companies.length > 0 ? <div><dt className="text-[12px] text-muted">Empresas</dt><dd>{contact.companies.map((x) => x.name).join(', ')}</dd></div> : null}
            </dl>
            <div><Link to="/contacts" className="inline-flex min-h-9 items-center rounded-[10px] border border-line px-3 py-1.5 text-[12.5px] font-semibold hover:bg-surface2">Ver en Contactos</Link></div>
          </Block>

          <Block id="tags" title="Etiquetas" st={st}>
            <div className="flex flex-wrap items-center gap-1.5"><ConversationTags c={c} /></div>
          </Block>

          {contact.attribution ? <Block id="origin" title="Origen del lead" st={st}><AttributionSection contact={contact} /></Block> : null}

          {filled.length > 0 ? (
            <Block id="custom" title="Campos personalizados" st={st}>
              <dl className="grid gap-1.5 text-[13px]">
                {filled.map((d) => <div key={d.id}><dt className="text-[12px] text-muted">{d.name}</dt><dd className="break-words">{customText(d, contact.custom_fields[d.key])}</dd></div>)}
              </dl>
            </Block>
          ) : null}

          <Block id="appointment" title="Próxima cita" st={st}>
            {appt.isPending ? <Spinner label="Cargando la cita" /> : appt.data ? (
              <p className="text-[13px]"><b>{shortDateTime(appt.data.starts_at)}</b> · {appt.data.kind}<span className="block text-[12px] text-muted">{appt.data.owner?.name ?? 'Sin responsable'} · {appt.data.duration_minutes} min</span></p>
            ) : <p className="text-[13px] text-muted">{appt.isError ? 'No tienes acceso a la agenda.' : 'No tiene citas próximas.'}</p>}
          </Block>

          <Block id="opportunities" title="Oportunidades" st={st} byDefault={false}><ContactOpportunitiesPanel contact={contact} canWrite viewAll={canAssign} owners={owners.data ?? []} /></Block>

          <Block id="sales" title="Últimas ventas" st={st}>
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

          <Block id="notes" title="Notas" st={st} byDefault={false}><NotesPanel target={{ kind: 'contact', id: contact.id }} canWrite /></Block>
          <Block id="tasks" title="Tareas" st={st} byDefault={false}><TasksPanel link={{ contact: { id: contact.id, name: contact.name } }} canWrite viewAll={canAssign} owners={owners.data ?? []} /></Block>
          {editing ? <ContactDialog contact={contact} owners={owners.data ?? []} canAssign={canAssign} canDelete={false} readOnly={false} onClose={() => { setEditing(false); void q.refetch(); }} /> : null}
        </>
      ) : null}
      {actions ? <DangerRows c={c} meId={actions.meId} onClose={onClose} onError={actions.onError} /> : null}
    </aside>
  );
}
