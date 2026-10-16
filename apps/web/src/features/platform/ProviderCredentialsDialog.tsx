import { useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import type { ProviderItem, ProviderService } from '../../lib/types';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useClearCredentials, useSaveCredentials } from './useProviders';

/**
 * Credenciales de UN proveedor (ADR-42; solo Súper Admin). TODO lo que se guarda aquí (claves, tokens, URL, región…) es de ESCRITURA: nunca se vuelve a
 * mostrar, solo se indica que existe y su final (últimos 4). Dejar un campo vacío lo conserva; «Quitar» lo elimina. El servidor valida y cifra todo.
 */
export function ProviderCredentialsDialog({ service, provider, active, vaultAvailable, onClose }: { service: ProviderService; provider: ProviderItem; active: boolean; vaultAvailable: boolean; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const save = useSaveCredentials();
  const clearAll = useClearCredentials();
  const anySet = provider.fields.some((f) => f.set);

  function submit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    setFormError(undefined);
    setSaved(false);
    const newValues = Object.fromEntries(provider.fields.filter((f) => (values[f.key] ?? '').trim() !== '' && !removing.has(f.key)).map((f) => [f.key, (values[f.key] ?? '').trim()]));
    const clear = [...removing];
    if (Object.keys(newValues).length + clear.length === 0) {
      setFormError('No hay cambios que guardar.');
      return;
    }
    save.mutate(
      { service: service.key, provider: provider.key, values: newValues, clear },
      {
        onSuccess: () => {
          setValues({});
          setRemoving(new Set());
          setSaved(true);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
            const next: Record<string, string> = {};
            for (const d of err.details) next[d.path.replace(/^values\./, '')] = d.message;
            setErrors(next);
          }
          setFormError(friendlyError(err, 'No pudimos guardar las credenciales.'));
        },
      },
    );
  }

  function removeAll() {
    setFormError(undefined);
    clearAll.mutate({ service: service.key, provider: provider.key }, { onSuccess: onClose, onError: (err) => { setConfirmClear(false); setFormError(friendlyError(err, 'No pudimos quitar las credenciales.')); } });
  }

  const toggleRemove = (key: string, on: boolean) => setRemoving((s) => { const n = new Set(s); if (on) n.add(key); else n.delete(key); return n; });

  return (
    <Modal title={`Credenciales de ${provider.label}`} onClose={onClose} wide>
      <p className="text-[13px] text-muted">{service.label} · <span className="font-mono text-[12px]">{service.adapter}</span>. Todo se guarda cifrado y no se puede volver a ver: solo verás cómo termina. Si lo pierdes, se reemplaza por uno nuevo.</p>
      {provider.note ? <Alert kind="info">{provider.note}</Alert> : null}
      {active ? <Alert kind="info">Este proveedor está en uso: puedes cambiar sus valores, pero no dejarlo incompleto ni quitarle las credenciales.</Alert> : null}
      {!vaultAvailable && provider.fields.length > 0 ? <Alert>Falta la clave de cifrado en el servidor (PROVIDER_CREDENTIALS_KEY): por ahora no se pueden guardar credenciales.</Alert> : null}
      <form onSubmit={submit} noValidate className="grid gap-3" aria-label={`Credenciales de ${provider.label}`}>
        {provider.fields.map((f) => (
          <div key={f.key} className="grid gap-1">
            <Field label={f.label} error={errors[f.key]} hint={f.set ? (removing.has(f.key) ? 'Se quitará al guardar.' : `Guardado${f.last4 ? ` (termina en ${f.last4})` : ''}. Déjalo vacío para conservarlo.`) : (f.hint ?? (f.required ? 'Obligatorio.' : 'Opcional.'))}>
              {(p) => <Input {...p} type={f.masked ? 'password' : 'text'} value={values[f.key] ?? ''} onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))} autoComplete={f.masked ? 'new-password' : 'off'} spellCheck={false} disabled={!vaultAvailable || removing.has(f.key)} placeholder={f.set ? '••••••••' : ''} />}
            </Field>
            {f.set && !active ? (
              <label className="flex items-center gap-2 text-[12.5px]">
                <input type="checkbox" checked={removing.has(f.key)} disabled={!vaultAvailable} onChange={(e) => toggleRemove(f.key, e.target.checked)} />
                <span>Quitar {f.label.toLowerCase()}</span>
              </label>
            ) : null}
          </div>
        ))}
        {provider.fields.length === 0 ? <p className="text-[13px] text-muted">Este proveedor no necesita credenciales.</p> : null}
        {formError ? <Alert>{formError}</Alert> : null}
        {saved ? <Alert kind="ok">Guardado.{provider.configured ? '' : ' Aún faltan datos obligatorios.'}</Alert> : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {anySet && !active ? (
            confirmClear ? (
              <span className="flex items-center gap-2 text-[13px]">¿Quitar todas?
                <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" loading={clearAll.isPending} onClick={removeAll}>Sí, quitar</Button>
                <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirmClear(false)}>No</Button>
              </span>
            ) : (
              <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirmClear(true)}>Quitar todas las credenciales</Button>
            )
          ) : <span />}
          <span className="flex gap-2">
            <Button type="button" onClick={onClose}>Cerrar</Button>
            {provider.fields.length > 0 ? <Button type="submit" variant="primary" loading={save.isPending}>Guardar</Button> : null}
          </span>
        </div>
      </form>
    </Modal>
  );
}
