import { useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Queue } from '../../lib/types';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { ColorPicker, DEFAULT_QUEUE_COLOR } from './ColorPicker';
import { useCreateQueue } from './useQueues';

/** Alta de una cola: nombre y color. Al crearla se abre su configuración (asesores y reparto). */
export function NewQueueDialog({ onCreated, onClose }: { onCreated: (q: Queue) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_QUEUE_COLOR);
  const [fieldError, setFieldError] = useState<string>();
  const [error, setError] = useState<string>();
  const create = useCreateQueue();

  function submit(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (n === '') return setFieldError('Escribe el nombre de la cola');
    if (n.length > 60) return setFieldError('Usa como máximo 60 caracteres');
    setFieldError(undefined);
    setError(undefined);
    create.mutate({ name: n, color }, { onSuccess: onCreated, onError: (err) => setError(friendlyError(err, 'No pudimos crear la cola.')) });
  }

  return (
    <Modal title="Nueva cola" onClose={onClose}>
      <form onSubmit={submit} noValidate className="grid gap-3" aria-label="Nueva cola">
        <Field label="Nombre" error={fieldError} hint="Un equipo o departamento, por ejemplo «Ventas» o «Soporte».">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" autoFocus />}
        </Field>
        <div className="grid gap-1.5 text-[12.5px] font-semibold">
          Color
          <ColorPicker value={color} onChange={setColor} />
        </div>
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>Crear cola</Button>
        </div>
      </form>
    </Modal>
  );
}
