import { useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Pipeline } from '../../lib/types';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useCreatePipeline } from './usePipelines';

/** Pipeline nuevo (M4.1): solo el nombre; nace con «Nuevo», «En seguimiento» y «Ganado» y se ajusta después desde «Etapas». */
export function NewPipelineDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Pipeline) => void }) {
  const [name, setName] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const [error, setError] = useState<string>();
  const create = useCreatePipeline();

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    const n = name.trim();
    if (n === '') return setFieldError('Escribe un nombre para el pipeline');
    if (n.length > 60) return setFieldError('Usa como máximo 60 caracteres');
    setFieldError(undefined);
    create.mutate(n, {
      onSuccess: onCreated,
      onError: (err) => {
        if ((err as { code?: string }).code === 'PIPELINE_EXISTS') return setFieldError('Ya existe un pipeline con ese nombre');
        setError(friendlyError(err, 'No pudimos crear el pipeline.'));
      },
    });
  }

  return (
    <Modal title="Nuevo pipeline" onClose={onClose}>
      <form onSubmit={submit} noValidate className="grid gap-3" aria-label="Nuevo pipeline">
        <Field label="Nombre del pipeline" error={fieldError} hint="Por ejemplo: Cursos, Renovaciones. Después podrás cambiar sus etapas.">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" autoFocus />}
        </Field>
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>Crear pipeline</Button>
        </div>
      </form>
    </Modal>
  );
}
