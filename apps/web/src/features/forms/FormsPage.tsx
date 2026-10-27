import { useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { FormDialog, STATUS_KIND, STATUS_LABEL } from './FormDialog';
import { useFormMutations, useForms, type FormCard } from './useForms';

function NewFormDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { create } = useFormMutations();
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (name.trim().length === 0) return setError('Escribe el nombre del formulario.');
    setError(undefined);
    create.mutate({ name: name.trim() }, { onSuccess: (f) => onCreated(f.id), onError: (e2) => setError(friendlyError(e2, 'No pudimos crear el formulario.')) });
  };
  return (
    <Modal title="Nuevo formulario" onClose={onClose}>
      <form onSubmit={submit} noValidate className="grid gap-3">
        <Field label="Nombre" required hint="Solo lo ves tú, por ejemplo «Landing curso de uñas».">{(f) => <Input {...f} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />}</Field>
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancelar</Button><Button type="submit" variant="primary" loading={create.isPending}>Crear formulario</Button></div>
      </form>
    </Modal>
  );
}

function Row({ f, onOpen }: { f: FormCard; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} aria-label={`Abrir el formulario ${f.name}`} className="grid w-full gap-1 rounded-2xl border border-line bg-surface px-4 py-3 text-left transition hover:border-accent">
        <span className="flex flex-wrap items-center gap-2"><b className="text-[15px]">{f.name}</b><Pill kind={STATUS_KIND[f.status]}>{STATUS_LABEL[f.status]}</Pill></span>
        <span className="text-[12.5px] text-muted">{f.field_count} {f.field_count === 1 ? 'campo' : 'campos'} · {f.submissions} {f.submissions === 1 ? 'envío' : 'envíos'}{f.last_submission_at ? ` · el último, ${new Date(f.last_submission_at).toLocaleDateString('es-EC')}` : ''}</span>
      </button>
    </li>
  );
}

/** Formularios (M9.1, ADR-09/54; F07): capta leads desde tus páginas. Se arma el formulario, se autoriza el dominio y se publica; cada envío crea o completa el contacto, abre su oportunidad y avisa a Meta. */
export function FormsPage() {
  const q = useForms();
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const items = q.data?.items ?? [];
  const max = q.data?.limits.max_forms ?? 50;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[22px] font-bold">Formularios</h1>
        <Button variant="primary" disabled={items.length >= max} onClick={() => setOpen('new')}>Nuevo formulario</Button>
      </div>
      <p className="max-w-[70ch] text-[13px] text-muted">Un formulario capta clientes desde tu página web. Cada persona que lo llena queda como contacto, con su consentimiento, en la cola y el pipeline que elijas.</p>
      {q.isLoading ? <Spinner label="Cargando formularios" /> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'Solo el administrador de la empresa puede ver y cambiar esto.')}</Alert> : null}
      {q.data && items.length === 0 ? <p className="text-[13px] text-muted">Aún no tienes formularios. Crea el primero para empezar a captar clientes.</p> : null}
      {items.length > 0 ? <ul aria-label="Formularios" className="grid gap-2">{items.map((f) => <Row key={f.id} f={f} onOpen={() => setOpen(f.id)} />)}</ul> : null}
      {open === 'new' ? <NewFormDialog onClose={() => setOpen(null)} onCreated={(id) => setOpen(id)} /> : null}
      {open && open !== 'new' ? <FormDialog id={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
