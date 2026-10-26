import { useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { AgentDialog } from './AgentDialog';
import { Avatar, COVER_CLASS } from './agentUi';
import { useAgentMutations, useAgents, type AgentCard } from './useAgents';

function Card({ a, onOpen }: { a: AgentCard; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} aria-label={`Abrir el agente ${a.name}`} className="grid w-full overflow-hidden rounded-2xl border border-line bg-surface text-left transition hover:border-accent">
        <span className={`h-14 ${COVER_CLASS[a.cover]}`} />
        <span className="-mt-7 grid gap-2 px-4 pb-4">
          <Avatar name={a.name} url={a.photo_url} />
          <span className="flex flex-wrap items-center gap-2"><b className="text-[15px]">{a.name}</b><Pill kind={a.active ? 'ok' : 'muted'}>{a.active ? 'Activo' : 'Apagado'}</Pill></span>
          {a.role ? <span className="text-[12.5px] text-muted">{a.role}</span> : null}
          <span className="flex flex-wrap gap-1.5">
            {a.channels.length === 0 ? <Pill kind="warn">Sin conexión</Pill> : a.channels.map((c) => <Pill key={c.id} kind="info">{c.name}</Pill>)}
          </span>
          <span className="text-[12px] text-muted">{a.documents} {a.documents === 1 ? 'documento' : 'documentos'} · {a.model}</span>
        </span>
      </button>
    </li>
  );
}

function NewAgentDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { create } = useAgentMutations();
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (name.trim().length === 0) return setError('Escribe el nombre del agente.');
    setError(undefined);
    create.mutate({ name: name.trim(), role: role.trim() || null }, { onSuccess: (a) => onCreated(a.id), onError: (e2) => setError(friendlyError(e2, 'No pudimos crear el agente.')) });
  };
  return (
    <Modal title="Nuevo agente" onClose={onClose}>
      <form onSubmit={submit} noValidate className="grid gap-3">
        <Field label="Nombre" required>{(f) => <Input {...f} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="¿Qué hace?" hint="Una línea, por ejemplo: «Asesora de ventas de cursos».">{(f) => <Input {...f} value={role} maxLength={120} onChange={(e) => setRole(e.target.value)} />}</Field>
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancelar</Button><Button type="submit" variant="primary" loading={create.isPending}>Crear agente</Button></div>
      </form>
    </Modal>
  );
}

/** Agentes IA (M8.3, ADR-20/53; F16): la galería de tarjetas y, al abrir una, sus ajustes en pestañas. El agente nace apagado; aún no responde mensajes (llega con M8.5). */
export function AgentsPage() {
  const q = useAgents();
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const items = q.data?.items ?? [];
  const max = q.data?.limits.max_agents ?? 20;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[22px] font-bold">Agentes IA</h1>
        <Button variant="primary" disabled={items.length >= max} onClick={() => setOpen('new')}>Nuevo agente</Button>
      </div>
      <p className="max-w-[70ch] text-[13px] text-muted">Un agente es un asistente que atiende a tus clientes con lo que tú le enseñas: su personalidad, sus documentos y las conexiones donde responde. Hoy puedes configurarlos y revisar sus instrucciones; empezarán a contestar mensajes en una próxima versión.</p>
      {q.isLoading ? <Spinner label="Cargando agentes" /> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'Solo el administrador de la empresa puede ver y cambiar esto.')}</Alert> : null}
      {q.data && items.length === 0 ? <p className="text-[13px] text-muted">Aún no tienes agentes. Crea el primero para empezar.</p> : null}
      {items.length > 0 ? <ul aria-label="Agentes" className="grid grid-cols-1 gap-3 min-[640px]:grid-cols-2 min-[960px]:grid-cols-3">{items.map((a) => <Card key={a.id} a={a} onOpen={() => setOpen(a.id)} />)}</ul> : null}
      {items.length >= max ? <p className="text-[12px] text-muted">Llegaste al máximo de {max} agentes: borra alguno para crear otro.</p> : null}
      {open === 'new' ? <NewAgentDialog onClose={() => setOpen(null)} onCreated={(id) => { setCreated(id); setOpen(id); }} /> : null}
      {open && open !== 'new' ? <AgentDialog id={open} justCreated={created === open} onClose={() => { setOpen(null); setCreated(null); }} /> : null}
    </div>
  );
}
