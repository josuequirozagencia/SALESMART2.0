import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Company } from '../../lib/types';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useSetStorageQuota } from './useCompanies';

const GB = 1024 * 1024 * 1024;
const gbText = (bytes: number): string => String(Math.round((bytes / GB) * 100) / 100).replace('.', ',');

/**
 * El tope de espacio de la biblioteca de archivos de una empresa (V21, ADR-75). Es un tope, no un espacio reservado: bajarlo no borra nada, solo frena las subidas nuevas mientras la empresa esté por encima.
 * Se escribe en GB (acepta decimales).
 */
export function StorageQuotaDialog({ company, onClose }: { company: Company; onClose: () => void }) {
  const [value, setValue] = useState(gbText(company.storage_quota_bytes));
  const [error, setError] = useState<string>();
  const save = useSetStorageQuota();
  const gb = Number(value.trim().replace(',', '.'));
  const valid = value.trim() !== '' && Number.isFinite(gb) && gb >= 0 && gb <= 10_240;
  const bytes = Math.round(gb * GB);
  const unchanged = valid && bytes === company.storage_quota_bytes;

  function confirm(): void {
    setError(undefined);
    save.mutate({ id: company.id, bytes }, { onSuccess: onClose, onError: (e) => setError(friendlyError(e, 'No se pudo cambiar el espacio')) });
  }

  return (
    <Modal title={`Espacio de ${company.name}`} onClose={onClose}>
      <Field label="Tope de la biblioteca (GB)" hint="Es un tope, no un espacio reservado. Bajarlo no borra archivos: solo se rechazan las subidas nuevas mientras la empresa esté por encima." error={value.trim() !== '' && !valid ? 'Escribe un número de 0 a 10 240' : undefined}>
        {(f) => <Input {...f} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />}
      </Field>
      <p className="text-[12.5px] text-muted">Ahora: {gbText(company.storage_quota_bytes)} GB.</p>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" disabled={!valid || unchanged} loading={save.isPending} onClick={confirm}>Guardar</Button>
      </div>
    </Modal>
  );
}
