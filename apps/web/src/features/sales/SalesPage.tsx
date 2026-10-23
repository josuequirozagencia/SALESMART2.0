import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { money } from '../../lib/format';
import { useSession } from '../../lib/session';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { METHOD_LABEL, useAddPayment, useIdempotencyKey, useCancelSale, useChangeRequests, useCorrectPayment, useRequestChange, useResolveRequest, useSale, useSales, useSalesSettings, useSetCurrency, type PaymentMethod, type Sale, type SaleFilters } from './useSales';

const SMALL = '!px-3 !py-1.5 !text-[12.5px]';
const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-[9px] text-[13.5px] font-normal text-fg';
const MONEY = /^\d{1,9}([.,]\d{1,2})?$/;
const asMoney = (v: string): string => v.trim().replace(',', '.');
const when = (iso: string): string => new Date(iso).toLocaleString('es-EC', { dateStyle: 'medium', timeStyle: 'short' });
const COMMON_CURRENCIES = ['USD', 'EUR', 'COP', 'PEN', 'MXN', 'ARS', 'CLP', 'BRL', 'BOB', 'UYU', 'PYG', 'GTQ', 'CRC', 'DOP', 'PAB'];

function StatusPill({ s }: { s: Sale }) {
  if (s.status === 'cancelled') return <Pill kind="crit">Anulada</Pill>;
  return s.collected ? <Pill kind="ok">Cobrada</Pill> : <Pill kind="warn">Con saldo</Pill>;
}

/** Venta abierta: abonos, saldo, historial, anular y corregir (administrador) o pedir una corrección (asesor). */
function SaleDetailDialog({ id, admin, onClose }: { id: string; admin: boolean; onClose: () => void }) {
  const q = useSale(id);
  const pay = useAddPayment(id);
  const correct = useCorrectPayment(id);
  const cancel = useCancelSale(id);
  const request = useRequestChange(id);
  const idem = useIdempotencyKey();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [note, setNote] = useState('');
  const [payError, setPayError] = useState<string>();
  const [panel, setPanel] = useState<'' | 'cancel' | 'correct' | 'request'>('');
  const [reason, setReason] = useState('');
  const [corrAmount, setCorrAmount] = useState('');
  const [panelError, setPanelError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const s = q.data;

  const addPayment = (): void => {
    setPayError(undefined);
    setNotice(undefined);
    if (!MONEY.test(amount.trim()) || Number(asMoney(amount)) <= 0) return setPayError('Un abono mayor que 0 con hasta 2 decimales');
    const input = { amount: asMoney(amount), method, ...(note.trim() ? { note: note.trim() } : {}) };
    pay.mutate(
      { key: idem.keyFor(input), input },
      { onSuccess: () => { idem.reset(); setAmount(''); setNote(''); setNotice('Abono registrado'); }, onError: (e) => setPayError(friendlyError(e, 'No se pudo registrar el abono')) },
    );
  };
  const submitPanel = (): void => {
    setPanelError(undefined);
    if (reason.trim() === '') return setPanelError('Escribe el motivo');
    const ok = () => { setPanel(''); setReason(''); setCorrAmount(''); };
    const fail = (e: unknown) => setPanelError(friendlyError(e, 'No se pudo completar la acción'));
    if (panel === 'cancel') cancel.mutate(reason.trim(), { onSuccess: () => { ok(); setNotice('Venta anulada'); }, onError: fail });
    else if (panel === 'request') request.mutate(reason.trim(), { onSuccess: () => { ok(); setNotice('Solicitud enviada a un administrador'); }, onError: fail });
    else if (panel === 'correct') {
      if (!MONEY.test(corrAmount.trim()) || Number(asMoney(corrAmount)) <= 0) return setPanelError('Un monto mayor que 0 con hasta 2 decimales');
      correct.mutate({ amount: asMoney(corrAmount), reason: reason.trim() }, { onSuccess: () => { ok(); setNotice('Corrección registrada'); }, onError: fail });
    }
  };
  const busy = cancel.isPending || request.isPending || correct.isPending;

  return (
    <Modal title="Venta" onClose={onClose} wide>
      {q.isPending ? <div className="grid place-items-center py-8 text-muted"><Spinner label="Cargando la venta" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No se pudo cargar la venta')}</Alert> : null}
      {s ? (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <b className="text-[15px]">{s.contact.name}</b>
              <p className="text-[12.5px] text-muted">{s.product.name} × {s.quantity} · {s.seller?.name ?? 'Sin vendedor'} · {when(s.created_at)}</p>
            </div>
            <StatusPill s={s} />
          </div>
          <dl className="grid grid-cols-3 gap-2 text-center">
            {[['Total', s.amount], ['Cobrado', s.paid], ['Saldo', s.balance]].map(([l, v]) => (
              <div key={l} className="rounded-xl border border-line px-2 py-2">
                <dt className="text-[11.5px] text-muted">{l}</dt>
                <dd className="font-mono text-[15px] font-bold">{money(v!, s.currency)}</dd>
              </div>
            ))}
          </dl>
          {s.note ? <p className="text-[13px]">Nota: {s.note}</p> : null}
          {s.status === 'cancelled' ? (
            <Alert>Anulada el {when(s.cancelled_at!)}: {s.cancel_reason}.{s.purchase_at_cancel === 'sent' ? ' El evento de compra ya se había enviado a Meta antes de anular.' : s.purchase_at_cancel === 'cancelled' ? ' El evento de compra se canceló antes de llegar a Meta.' : ''}</Alert>
          ) : null}

          <section aria-label="Abonos" className="grid gap-1">
            <span className="text-[13px] font-semibold">Abonos</span>
            {s.payments.length === 0 ? <p className="text-[12.5px] text-muted">Todavía no hay abonos.</p> : (
              <ul className="grid gap-1">
                {s.payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-1.5 text-[13px]">
                    <span>{p.kind === 'correction' ? <Pill kind="warn">Corrección</Pill> : <Pill kind="muted">{METHOD_LABEL[p.method ?? 'other']}</Pill>} <span className="text-muted">{when(p.created_at)} · {p.by?.name ?? '—'}{p.reason ? ` · ${p.reason}` : p.note ? ` · ${p.note}` : ''}</span></span>
                    <b className="font-mono">{p.kind === 'correction' ? '−' : ''}{money(p.amount, s.currency)}</b>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {s.can.pay ? (
            <section aria-label="Registrar abono" className="grid items-start gap-2 sm:grid-cols-[130px_150px_minmax(0,1fr)_auto]">
              <Field label="Abono">{(f) => <Input {...f} inputMode="decimal" value={amount} placeholder={s.balance} onChange={(e) => setAmount(e.target.value)} />}</Field>
              <Field label="Método">
                {(f) => (
                  <select {...f} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} className={`${selectCls} w-full`}>
                    {Object.entries(METHOD_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                )}
              </Field>
              <Field label="Nota (opcional)">{(f) => <Input {...f} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}</Field>
              <div className="sm:pt-[22px]"><Button variant="primary" loading={pay.isPending} onClick={addPayment}>Registrar abono</Button></div>
            </section>
          ) : null}
          {payError ? <Alert>{payError}</Alert> : null}
          {notice ? <Alert kind="ok">{notice}</Alert> : null}

          {s.change_requests.length > 0 ? (
            <section aria-label="Solicitudes de corrección" className="grid gap-1">
              <span className="text-[13px] font-semibold">Solicitudes de corrección</span>
              <ul className="grid gap-1">
                {s.change_requests.map((r) => (
                  <li key={r.id} className="rounded-lg border border-line px-3 py-1.5 text-[13px]">
                    <Pill kind={r.status === 'open' ? 'warn' : r.status === 'resolved' ? 'ok' : 'muted'}>{r.status === 'open' ? 'Abierta' : r.status === 'resolved' ? 'Resuelta' : 'Descartada'}</Pill> {r.reason}
                    <span className="block text-[12px] text-muted">{r.requested_by?.name ?? '—'} · {when(r.created_at)}{r.resolution_note ? ` · ${r.resolution_note}` : ''}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {panel ? (
            <section aria-label={panel === 'cancel' ? 'Anular venta' : panel === 'correct' ? 'Corregir cobrado' : 'Pedir corrección'} className="grid gap-2 rounded-xl border border-line p-3">
              <b className="text-[13.5px]">{panel === 'cancel' ? 'Anular la venta' : panel === 'correct' ? 'Corregir lo cobrado' : 'Pedir una corrección a un administrador'}</b>
              {panel === 'correct' ? <Field label="Monto a restar de lo cobrado">{(f) => <Input {...f} inputMode="decimal" value={corrAmount} onChange={(e) => setCorrAmount(e.target.value)} />}</Field> : null}
              <Field label={panel === 'request' ? 'Qué hay que corregir' : 'Motivo'}>{(f) => <Input {...f} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}</Field>
              {panelError ? <span role="alert" className="text-[12px] font-medium text-crit">{panelError}</span> : null}
              <div className="flex justify-end gap-2">
                <Button className={SMALL} onClick={() => { setPanel(''); setPanelError(undefined); }}>Cancelar</Button>
                <Button variant={panel === 'cancel' ? 'danger' : 'primary'} className={SMALL} loading={busy} onClick={submitPanel}>{panel === 'cancel' ? 'Anular venta' : panel === 'correct' ? 'Registrar corrección' : 'Enviar solicitud'}</Button>
              </div>
            </section>
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              {admin && s.can.correct ? <Button className={SMALL} onClick={() => { setPanel('correct'); setNotice(undefined); }}>Corregir cobrado</Button> : null}
              {admin && s.can.cancel ? <Button variant="danger" className={SMALL} onClick={() => { setPanel('cancel'); setNotice(undefined); }}>Anular venta</Button> : null}
              {!admin && s.can.request_change ? <Button className={SMALL} onClick={() => { setPanel('request'); setNotice(undefined); }}>Pedir corrección</Button> : null}
            </div>
          )}
        </div>
      ) : null}
      <div className="flex justify-end"><Button onClick={onClose}>Cerrar</Button></div>
    </Modal>
  );
}

/** Solicitudes de corrección abiertas (administrador): se resuelven o se descartan. */
function RequestsPanel() {
  const q = useChangeRequests(true);
  const resolve = useResolveRequest();
  const [error, setError] = useState<string>();
  const items = q.data?.items ?? [];
  if (items.length === 0) return null;
  const act = (id: string, status: 'resolved' | 'dismissed'): void => {
    setError(undefined);
    resolve.mutate({ id, status }, { onError: (e) => setError(friendlyError(e, 'No se pudo resolver la solicitud')) });
  };
  return (
    <section aria-label="Solicitudes de corrección abiertas" className="grid gap-2 rounded-2xl border border-line p-4">
      <b className="text-[14px]">Solicitudes de corrección ({items.length})</b>
      <ul className="grid gap-2">
        {items.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2 text-[13px]">
            <span><b>{r.sale.contact}</b> · {money(r.sale.amount, r.sale.currency)}<span className="block text-muted">{r.reason} — {r.requested_by?.name ?? '—'}</span></span>
            <span className="flex gap-2">
              <Button className={SMALL} aria-label={`Descartar la solicitud de ${r.sale.contact}`} onClick={() => act(r.id, 'dismissed')}>Descartar</Button>
              <Button variant="primary" className={SMALL} aria-label={`Marcar resuelta la solicitud de ${r.sale.contact}`} onClick={() => act(r.id, 'resolved')}>Resuelta</Button>
            </span>
          </li>
        ))}
      </ul>
      {error ? <Alert>{error}</Alert> : null}
    </section>
  );
}

/** Moneda de la empresa: se puede cambiar solo mientras no haya ventas registradas. */
function CurrencyBar() {
  const q = useSalesSettings();
  const set = useSetCurrency();
  const [error, setError] = useState<string>();
  if (!q.data) return null;
  const { currency, locked } = q.data;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <span className="text-muted">Moneda de la empresa:</span>
      <select aria-label="Moneda de la empresa" value={currency} disabled={locked || set.isPending} onChange={(e) => { setError(undefined); set.mutate(e.target.value, { onError: (err) => setError(friendlyError(err, 'No se pudo cambiar la moneda')) }); }} className={selectCls}>
        {[...new Set([currency, ...COMMON_CURRENCIES])].map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      {locked ? <span className="text-[12px] text-muted">Ya hay ventas: no se puede cambiar.</span> : null}
      {error ? <span role="alert" className="text-[12px] font-medium text-crit">{error}</span> : null}
    </div>
  );
}

/**
 * Ventas (M6.2, F14): la lista de ventas con su saldo, filtros por estado y por cobrar, y el detalle con abonos. El asesor ve las suyas; quien ve todo (administrador),
 * las de la empresa. Anular, corregir y resolver solicitudes son del administrador (el servidor lo vuelve a exigir).
 */
export function SalesPage() {
  const { state } = useSession();
  const role = state.status === 'authed' ? state.me.role : 'advisor';
  const admin = role === 'client_admin' || role === 'agency' || role === 'super_admin';
  const [filters, setFilters] = useState<SaleFilters>({ status: '', collected: '' });
  const [open, setOpen] = useState<string>();
  const q = useSales(filters);
  const items = q.data?.items ?? [];
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[20px] font-bold">Ventas</h1>
        {admin ? <CurrencyBar /> : null}
      </div>
      {admin ? <RequestsPanel /> : null}
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <label className="flex items-center gap-2">Estado
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as SaleFilters['status'] })} className={selectCls}>
            <option value="">Todas</option>
            <option value="active">Vigentes</option>
            <option value="cancelled">Anuladas</option>
          </select>
        </label>
        <label className="flex items-center gap-2">Cobro
          <select value={filters.collected} onChange={(e) => setFilters({ ...filters, collected: e.target.value as SaleFilters['collected'] })} className={selectCls}>
            <option value="">Todas</option>
            <option value="no">Con saldo por cobrar</option>
            <option value="yes">Cobradas</option>
          </select>
        </label>
      </div>
      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando ventas" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No se pudieron cargar las ventas')}</Alert> : null}
      {q.isSuccess && items.length === 0 ? <p className="py-8 text-center text-[13.5px] text-muted">Todavía no hay ventas. Se registran desde una conversación, con «Registrar venta».</p> : null}
      {items.length > 0 ? (
        <ul className="grid gap-2" aria-label="Ventas">
          {items.map((s) => (
            <li key={s.id}>
              <button type="button" aria-label={`Abrir la venta de ${s.contact.name}`} onClick={() => setOpen(s.id)} className="grid w-full gap-1 rounded-xl border border-line bg-surface px-4 py-3 text-left hover:bg-surface2">
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <b className="text-[14px]">{s.contact.name}</b>
                  <StatusPill s={s} />
                </span>
                <span className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-muted">
                  <span>{s.product.name} × {s.quantity} · {s.seller?.name ?? '—'} · {when(s.created_at)}{s.open_requests > 0 ? ` · ${s.open_requests} solicitud(es)` : ''}</span>
                  <span className="font-mono text-fg">{money(s.amount, s.currency)}{s.status === 'active' && !s.collected ? ` · saldo ${money(s.balance, s.currency)}` : ''}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? <SaleDetailDialog id={open} admin={admin} onClose={() => setOpen(undefined)} /> : null}
    </div>
  );
}
