import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { money } from '../../lib/format';
import type { QueueProduct } from '../../lib/types';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { useCreateProduct, useQueueProducts, useUpdateProduct } from './useQueues';

const KIND_LABEL: Record<QueueProduct['kind'], string> = { product: 'Producto', service: 'Servicio' };
const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg';
/** Precio como lo acepta el servidor: hasta 9 enteros y 2 decimales. */
const PRICE = /^\d{1,9}([.,]\d{1,2})?$/;
const asPrice = (v: string): string => v.trim().replace(',', '.');

/**
 * Catálogo de productos y servicios de la cola (M6.1, ADR-08): lo que sus asesores podrán vender (M6.2). Cada cambio se guarda al instante (no depende del botón
 * «Guardar» de la cola). Un producto no se borra: se desactiva, y ya no aparece al registrar ventas.
 */
export function ProductsSection({ queueId }: { queueId: string }) {
  const products = useQueueProducts(queueId);
  const create = useCreateProduct(queueId);
  const update = useUpdateProduct(queueId);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<QueueProduct['kind']>('product');
  const [price, setPrice] = useState('');
  const [errors, setErrors] = useState<{ name?: string; price?: string }>({});
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState({ name: '', kind: 'product' as QueueProduct['kind'], price: '' });
  const [editError, setEditError] = useState<string>();

  const data = products.data;
  const currency = data?.currency ?? 'USD';

  const add = (): void => {
    const e: typeof errors = {};
    if (name.trim() === '') e.name = 'Escribe el nombre';
    if (!PRICE.test(price.trim())) e.price = 'Un precio con hasta 2 decimales, por ejemplo 12.50';
    setErrors(e);
    setError(undefined);
    if (Object.keys(e).length > 0) return;
    create.mutate({ name: name.trim(), kind, price: asPrice(price) }, {
      onSuccess: () => { setName(''); setPrice(''); setKind('product'); },
      onError: (err) => setError(friendlyError(err, 'No se pudo agregar el producto')),
    });
  };

  const startEdit = (p: QueueProduct): void => {
    setEditing(p.id);
    setDraft({ name: p.name, kind: p.kind, price: p.price });
    setEditError(undefined);
  };
  const saveEdit = (p: QueueProduct): void => {
    if (draft.name.trim() === '') return setEditError('Escribe el nombre');
    if (!PRICE.test(draft.price.trim())) return setEditError('Un precio con hasta 2 decimales, por ejemplo 12.50');
    update.mutate({ productId: p.id, input: { name: draft.name.trim(), kind: draft.kind, price: asPrice(draft.price) } }, {
      onSuccess: () => setEditing(undefined),
      onError: (err) => setEditError(friendlyError(err, 'No se pudo guardar el producto')),
    });
  };
  const toggle = (p: QueueProduct): void => {
    setError(undefined);
    update.mutate({ productId: p.id, input: { active: !p.active } }, { onError: (err) => setError(friendlyError(err, 'No se pudo cambiar el producto')) });
  };

  return (
    <section className="grid gap-3 rounded-2xl border border-line p-4" aria-label="Catálogo de productos y servicios">
      <div>
        <span className="text-[13.5px] font-semibold">Catálogo de productos y servicios</span>
        <p className="text-[12.5px] text-muted">Lo que se puede vender desde este departamento. El precio es el sugerido (en {currency}); al registrar la venta se puede ajustar. Un departamento sin productos activos no puede vender.</p>
      </div>

      {products.isPending ? <p className="text-[13px] text-muted">Cargando el catálogo…</p> : null}
      {products.isError ? <Alert>No se pudo cargar el catálogo</Alert> : null}
      {data && data.items.length === 0 ? <p className="text-[13px] text-muted">Todavía no hay productos. Agrega el primero abajo.</p> : null}

      {data && data.items.length > 0 ? (
        <ul className="grid gap-2" aria-label="Productos del departamento">
          {data.items.map((p) => (
            <li key={p.id} className={`grid gap-2 rounded-xl border border-line px-3 py-2 ${p.active ? '' : 'opacity-60'}`}>
              {editing === p.id ? (
                <div className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_130px_120px_auto]">
                  <Field label="Nombre">{(f) => <Input {...f} value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}</Field>
                  <Field label="Tipo">
                    {(f) => (
                      <select {...f} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as QueueProduct['kind'] })} className={selectCls}>
                        <option value="product">Producto</option>
                        <option value="service">Servicio</option>
                      </select>
                    )}
                  </Field>
                  <Field label="Precio">{(f) => <Input {...f} inputMode="decimal" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} />}</Field>
                  <span className="flex gap-2">
                    <Button className="!px-3 !py-2 !text-[12.5px]" onClick={() => setEditing(undefined)}>Cancelar</Button>
                    <Button variant="primary" className="!px-3 !py-2 !text-[12.5px]" loading={update.isPending} onClick={() => saveEdit(p)}>Guardar producto</Button>
                  </span>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0">
                    <b className="break-words text-[14px]">{p.name}</b>
                    <span className="ml-2"><Pill kind={p.kind === 'service' ? 'info' : 'muted'}>{KIND_LABEL[p.kind]}</Pill></span>
                    {!p.active ? <span className="ml-2"><Pill kind="muted">Desactivado</Pill></span> : null}
                  </span>
                  <span className="flex items-center gap-2">
                    <b className="font-mono text-[13.5px]">{money(p.price, currency)}</b>
                    <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Editar ${p.name}`} onClick={() => startEdit(p)}>Editar</Button>
                    <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`${p.active ? 'Desactivar' : 'Activar'} ${p.name}`} onClick={() => toggle(p)}>{p.active ? 'Desactivar' : 'Activar'}</Button>
                  </span>
                </div>
              )}
              {editing === p.id && editError ? <span role="alert" className="text-[12px] font-medium text-crit">{editError}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid items-start gap-2 sm:grid-cols-[minmax(0,1fr)_130px_120px_auto]" role="group" aria-label="Agregar producto">
        <Field label="Nombre" error={errors.name}>{(f) => <Input {...f} value={name} maxLength={120} placeholder="Corte de cabello" onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Tipo">
          {(f) => (
            <select {...f} value={kind} onChange={(e) => setKind(e.target.value as QueueProduct['kind'])} className={selectCls}>
              <option value="product">Producto</option>
              <option value="service">Servicio</option>
            </select>
          )}
        </Field>
        <Field label={`Precio (${currency})`} error={errors.price}>{(f) => <Input {...f} inputMode="decimal" value={price} placeholder="12.50" onChange={(e) => setPrice(e.target.value)} />}</Field>
        <div className="sm:pt-[22px]"><Button variant="primary" loading={create.isPending} onClick={add}>Agregar</Button></div>
      </div>
      {error ? <Alert>{error}</Alert> : null}
    </section>
  );
}
