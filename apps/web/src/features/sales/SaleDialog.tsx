import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { money } from '../../lib/format';
import type { Conversation } from '../../lib/types';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { METHOD_LABEL, useCreateSale, useIdempotencyKey, useSaleOptions, type PaymentMethod } from './useSales';

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg';
const MONEY = /^\d{1,9}([.,]\d{1,2})?$/;
const asMoney = (v: string): string => v.trim().replace(',', '.');
const cents = (v: string): number => Math.round(Number(asMoney(v)) * 100);

const BLOCKED: Record<NonNullable<ReturnType<typeof useSaleOptions>['data']>['blocked'] & string, string> = {
  no_queue: 'Esta conversación no pertenece a ningún departamento: sin departamento no hay catálogo para vender. Un administrador debe asignarle un departamento.',
  no_products: 'El departamento de esta conversación no tiene productos o servicios activos. Un administrador puede agregarlos en Departamentos.',
  unassigned: 'La conversación aún no tiene asesor: asígnala o tómala antes de registrar la venta.',
  not_owner: 'Solo quien tiene asignada la conversación, o un administrador, puede registrar la venta.',
};

/**
 * «Registrar venta» desde el chat (F14, ADR-08): producto del catálogo de la cola, cantidad, TOTAL, abono inicial y método. El saldo se calcula (total − abono). La
 * llave de idempotencia se crea al abrir el formulario y se reutiliza si se reintenta el mismo envío: un doble clic no duplica la venta.
 */
export function SaleDialog({ c, onClose }: { c: Conversation; onClose: () => void }) {
  const options = useSaleOptions(c.id, true);
  const create = useCreateSale();
  const idem = useIdempotencyKey();
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [total, setTotal] = useState('');
  const [totalEdited, setTotalEdited] = useState(false);
  const [down, setDown] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Partial<Record<'product' | 'quantity' | 'total' | 'down', string>>>({});
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ amount: string; balance: string; currency: string }>();

  const data = options.data;
  const currency = data?.currency ?? 'USD';
  const product = data?.products.find((p) => p.id === productId);
  const qty = /^\d+$/.test(quantity) ? Number(quantity) : 0;
  // El total sugerido es precio × cantidad; si la persona lo escribe, se respeta lo suyo
  const suggested = product && qty > 0 ? ((cents(product.price) * qty) / 100).toFixed(2) : '';
  const shownTotal = totalEdited ? total : suggested;
  const balance = MONEY.test(shownTotal.trim()) ? Math.max(cents(shownTotal) - (MONEY.test(down.trim()) ? cents(down) : 0), 0) : null;

  const submit = (): void => {
    const e: typeof errors = {};
    if (!product) e.product = 'Elige el producto o servicio';
    if (qty < 1 || qty > 9999) e.quantity = 'Una cantidad entre 1 y 9999';
    if (!MONEY.test(shownTotal.trim()) || cents(shownTotal) <= 0) e.total = 'Un total mayor que 0 con hasta 2 decimales';
    const downOk = down.trim() === '' || MONEY.test(down.trim());
    if (!downOk) e.down = 'Un monto con hasta 2 decimales';
    else if (down.trim() !== '' && MONEY.test(shownTotal.trim()) && cents(down) > cents(shownTotal)) e.down = 'El abono no puede ser mayor que el total';
    setErrors(e);
    setError(undefined);
    if (Object.keys(e).length > 0) return;
    const downAmount = down.trim() === '' ? 0 : cents(down);
    const input = {
      conversation_id: c.id,
      product_id: productId,
      quantity: qty,
      amount: asMoney(shownTotal),
      ...(downAmount > 0 ? { down_payment: asMoney(down), method } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    create.mutate(
      {
        key: idem.keyFor(input),
        input,
      },
      {
        onSuccess: (s) => setDone({ amount: s.amount, balance: s.balance, currency: s.currency }),
        onError: (err) => setError(friendlyError(err, 'No se pudo registrar la venta')),
      },
    );
  };

  if (done) {
    return (
      <Modal title="Venta registrada" onClose={onClose}>
        <Alert kind="ok">Venta de {money(done.amount, done.currency)} registrada. {Number(done.balance) > 0 ? `Saldo por cobrar: ${money(done.balance, done.currency)}.` : 'Queda cobrada por completo.'}</Alert>
        <p className="text-[12.5px] text-muted">El contacto recibió la etiqueta «Venta» y su oportunidad pasó a ganada. Los abonos siguientes se registran desde Ventas.</p>
        <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Listo</Button></div>
      </Modal>
    );
  }

  return (
    <Modal title="Registrar venta" onClose={onClose}>
      {options.isPending ? <div className="grid place-items-center py-6 text-muted"><Spinner label="Cargando el catálogo" /></div> : null}
      {options.isError ? <Alert>{friendlyError(options.error, 'No se pudo cargar el catálogo del departamento')}</Alert> : null}
      {data?.blocked ? <Alert>{BLOCKED[data.blocked]}</Alert> : null}
      {data && !data.blocked ? (
        <div className="grid gap-3">
          <p className="text-[12.5px] text-muted">Cliente: <b>{c.contact.name}</b> · Departamento: <b>{data.queue?.name}</b> · Moneda: <b>{currency}</b></p>
          <Field label="Producto o servicio" error={errors.product}>
            {(f) => (
              <select {...f} value={productId} onChange={(e) => { setProductId(e.target.value); setTotalEdited(false); }} className={selectCls}>
                <option value="">Elige uno…</option>
                {data.products.map((p) => <option key={p.id} value={p.id}>{p.name} · {money(p.price, currency)}</option>)}
              </select>
            )}
          </Field>
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Field label="Cantidad" error={errors.quantity}>{(f) => <Input {...f} inputMode="numeric" value={quantity} onChange={(e) => { setQuantity(e.target.value); setTotalEdited(false); }} />}</Field>
            <Field label={`Total de la venta (${currency})`} error={errors.total} hint="Se sugiere precio × cantidad; puedes ajustarlo.">
              {(f) => <Input {...f} inputMode="decimal" value={shownTotal} onChange={(e) => { setTotal(e.target.value); setTotalEdited(true); }} />}
            </Field>
          </div>
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Field label="Abono inicial (opcional)" error={errors.down}>{(f) => <Input {...f} inputMode="decimal" value={down} placeholder="0.00" onChange={(e) => setDown(e.target.value)} />}</Field>
            <Field label="Método del abono">
              {(f) => (
                <select {...f} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} className={selectCls}>
                  {Object.entries(METHOD_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              )}
            </Field>
          </div>
          <p className="text-[13px]" aria-live="polite">Saldo por cobrar: <b className="font-mono">{balance === null ? '—' : money((balance / 100).toFixed(2), currency)}</b></p>
          <Field label="Nota (opcional)">{(f) => <Input {...f} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}</Field>
        </div>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        {data && !data.blocked ? <Button variant="primary" loading={create.isPending} onClick={submit}>Registrar venta</Button> : null}
      </div>
    </Modal>
  );
}
