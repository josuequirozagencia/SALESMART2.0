import { useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import { useIdempotencyKey } from '../../lib/idempotency';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { KIND_LABEL, useAiLedger, useAiModels, useAiOrgs, useAiPlatformMutations, useSetModelPrice, type AiModelPrice, type AiOrg, type AiPricing } from '../ai/useAiCredits';

const n = (v: number): string => v.toLocaleString('es-EC');
const when = (iso: string): string => new Date(iso).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
const DECIMAL = /^\d{1,4}(\.\d{1,6})?$/;
const SMALL = '!px-3 !py-1.5 !text-[12.5px]';
const num = (v: string): string => String(Number(v)); // «0.010000» → «0.01»

function PricingForm({ p }: { p: AiPricing }) {
  const { setPricing } = useAiPlatformMutations();
  const [usd, setUsd] = useState(num(p.usd_per_credit));
  const [margin, setMargin] = useState(num(p.global_margin_pct));
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    setSaved(false);
    if (!DECIMAL.test(usd.trim()) || Number(usd) <= 0 || Number(usd) > 100) return setError('El valor del crédito debe ser mayor que 0 y hasta 100 USD.');
    if (!DECIMAL.test(margin.trim()) || Number(margin) > 1000) return setError('El margen debe ser un número de 0 a 1000.');
    setError(undefined);
    setPricing.mutate({ usd_per_credit: usd.trim(), global_margin_pct: margin.trim() }, { onSuccess: () => setSaved(true), onError: (e2) => setError(friendlyError(e2, 'No pudimos guardar el precio.')) });
  };
  return (
    <form onSubmit={submit} noValidate aria-label="Precio de los créditos" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
      <h2 className="text-[15px] font-bold">Precio de los créditos</h2>
      <p className="max-w-[70ch] text-[12.5px] text-muted">Se cobra «costo real × (1 + margen) ÷ valor del crédito», redondeado hacia arriba. Estos valores son de ejemplo hasta que cargues los reales. El cliente nunca ve el costo ni el margen.</p>
      <div className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2">
        <Field label="Valor de un crédito (USD)">{(f) => <Input {...f} inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} />}</Field>
        <Field label="Margen global (%)">{(f) => <Input {...f} inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} />}</Field>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      {saved ? <Alert kind="ok">Precio guardado.</Alert> : null}
      <div><Button type="submit" variant="primary" loading={setPricing.isPending}>Guardar precio</Button></div>
    </form>
  );
}

function ModelRow({ m }: { m: AiModelPrice }) {
  const set = useSetModelPrice();
  const [input, setInput] = useState(num(m.usd_per_1m_input));
  const [output, setOutput] = useState(num(m.usd_per_1m_output));
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    setSaved(false);
    if (!DECIMAL.test(input.trim()) || Number(input) > 10000 || !DECIMAL.test(output.trim()) || Number(output) > 10000) return setError('Dos números de 0 a 10000.');
    setError(undefined);
    set.mutate({ model: m.model, usd_per_1m_input: input.trim(), usd_per_1m_output: output.trim() }, { onSuccess: () => setSaved(true), onError: (e2) => setError(friendlyError(e2, 'No pudimos guardar el precio.')) });
  };
  return (
    <li className="py-3">
      <form onSubmit={submit} noValidate aria-label={`Precio de ${m.model}`} className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2"><b className="text-[13.5px]">{m.model}</b><Pill kind="muted">{m.kind === 'embedding' ? 'Embeddings' : 'Chat'}</Pill></div>
        <div className="grid grid-cols-1 gap-2 min-[560px]:grid-cols-3 min-[560px]:items-end">
          <Field label="Entrada (USD por millón de tokens)">{(f) => <Input {...f} inputMode="decimal" value={input} onChange={(e) => setInput(e.target.value)} />}</Field>
          <Field label="Salida (USD por millón de tokens)">{(f) => <Input {...f} inputMode="decimal" value={output} onChange={(e) => setOutput(e.target.value)} />}</Field>
          <div><Button type="submit" loading={set.isPending}>Guardar</Button></div>
        </div>
        {error ? <Alert>{error}</Alert> : null}
        {saved ? <Alert kind="ok">Precio guardado.</Alert> : null}
      </form>
    </li>
  );
}

function ModelPrices() {
  const q = useAiModels();
  return (
    <section aria-label="Modelos de IA" className="grid gap-2 rounded-2xl border border-line bg-surface p-4">
      <h2 className="text-[15px] font-bold">Modelos de IA</h2>
      <p className="max-w-[70ch] text-[12.5px] text-muted">Lo que cobra el proveedor por millón de tokens. Con esto y los tokens de cada llamada se calcula el costo real que luego pasa por el margen. Valores de ejemplo hasta que cargues los reales.</p>
      {q.isLoading ? <Spinner label="Cargando modelos" /> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los modelos.')}</Alert> : null}
      {q.data ? <ul className="divide-y divide-line">{q.data.map((m) => <ModelRow key={m.model} m={m} />)}</ul> : null}
    </section>
  );
}

function GrantDialog({ org, onClose }: { org: AiOrg; onClose: () => void }) {
  const { grant } = useAiPlatformMutations();
  const idem = useIdempotencyKey();
  const [credits, setCredits] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<number>();
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const c = Number(credits);
    if (!/^\d+$/.test(credits.trim()) || c < 1 || c > 1_000_000) return setError('Un número entero de créditos entre 1 y 1.000.000.');
    if (note.trim().length < 3) return setError('Escribe el motivo (lo verá el cliente en sus movimientos).');
    setError(undefined);
    // La llave cambia solo si cambian los datos: un doble clic o un reintento de red no regala dos veces
    grant.mutate({ id: org.id, credits: c, note: note.trim(), key: idem.keyFor({ c, note: note.trim(), id: org.id }) }, { onSuccess: (r) => { setDone(r.balance); idem.reset(); }, onError: (e2) => setError(friendlyError(e2, 'No pudimos regalar los créditos.')) });
  };
  return (
    <Modal title={`Regalar créditos a ${org.name}`} onClose={onClose}>
      {done !== undefined ? (
        <>
          <Alert kind="ok">Listo. El saldo de {org.name} ahora es de {n(done)} créditos.</Alert>
          <div className="flex justify-end"><Button onClick={onClose}>Cerrar</Button></div>
        </>
      ) : (
        <form onSubmit={submit} noValidate className="grid gap-3">
          <Field label="Créditos">{(f) => <Input {...f} inputMode="numeric" value={credits} onChange={(e) => setCredits(e.target.value)} />}</Field>
          <Field label="Motivo" hint="Lo ve el cliente en sus movimientos.">{(f) => <Input {...f} value={note} maxLength={150} onChange={(e) => setNote(e.target.value)} />}</Field>
          {error ? <Alert>{error}</Alert> : null}
          <div className="flex justify-end gap-2"><Button type="button" onClick={onClose}>Cancelar</Button><Button type="submit" variant="primary" loading={grant.isPending}>Regalar</Button></div>
        </form>
      )}
    </Modal>
  );
}

function MarginDialog({ org, onClose }: { org: AiOrg; onClose: () => void }) {
  const { setMargin } = useAiPlatformMutations();
  const [value, setValue] = useState(num(org.margin_pct));
  const [error, setError] = useState<string>();
  const save = (margin_pct: string | null): void => {
    if (margin_pct !== null && (!DECIMAL.test(margin_pct) || Number(margin_pct) > 1000)) return setError('Un número de 0 a 1000.');
    setError(undefined);
    setMargin.mutate({ id: org.id, margin_pct }, { onSuccess: onClose, onError: (e) => setError(friendlyError(e, 'No pudimos guardar el margen.')) });
  };
  return (
    <Modal title={`Margen de ${org.name}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); save(value.trim()); }} noValidate className="grid gap-3">
        <Field label="Margen propio (%)" hint="Sustituye al margen global solo para esta empresa.">{(f) => <Input {...f} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex flex-wrap justify-end gap-2">
          {org.margin_override ? <Button type="button" loading={setMargin.isPending} onClick={() => save(null)}>Usar el global</Button> : null}
          <Button type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary" loading={setMargin.isPending}>Guardar</Button>
        </div>
      </form>
    </Modal>
  );
}

function LedgerDialog({ org, onClose }: { org: AiOrg; onClose: () => void }) {
  const q = useAiLedger(org.id);
  const items = (q.data?.pages ?? []).flatMap((p) => p.items);
  return (
    <Modal title={`Movimientos de ${org.name}`} onClose={onClose} wide>
      {q.isLoading ? <Spinner label="Cargando movimientos" /> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los movimientos.')}</Alert> : null}
      {q.data && items.length === 0 ? <p className="text-[13px] text-muted">Aún no hay movimientos.</p> : null}
      {items.length > 0 ? (
        <ul aria-label="Movimientos" className="max-h-[50vh] divide-y divide-line overflow-y-auto">
          {items.map((i) => (
            <li key={i.id} className="grid gap-0.5 py-2 text-[13px]">
              <span className="flex flex-wrap items-baseline gap-2"><Pill kind={i.credits > 0 ? 'ok' : 'muted'}>{KIND_LABEL[i.kind]}</Pill><b>{i.credits > 0 ? '+' : '−'}{n(Math.abs(i.credits))}</b><span className="text-muted">{i.ref ?? ''}</span></span>
              <span className="text-[12px] text-muted">Saldo {n(i.balance_after)} · {when(i.created_at)}{i.cost_usd !== null ? ` · costo ${i.cost_usd} USD · margen ${i.margin_pct ?? '—'} %` : ''}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">{q.hasNextPage ? <Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Ver más</Button> : null}<Button onClick={onClose}>Cerrar</Button></div>
    </Modal>
  );
}

/** Pestaña «Créditos IA» de la consola de plataforma (M8.1): precio y margen, saldo de cada empresa, regalos y libro con costo y margen. SOLO Súper Admin. */
export function AiCreditsPage() {
  const [search, setSearch] = useState('');
  const q = useAiOrgs(search);
  const [dialog, setDialog] = useState<{ kind: 'grant' | 'margin' | 'ledger'; org: AiOrg } | null>(null);
  const close = (): void => setDialog(null);
  return (
    <div className="grid gap-4">
      {q.data ? <PricingForm p={q.data.pricing} /> : null}
      <ModelPrices />
      <section aria-label="Créditos por empresa" className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[15px] font-bold">Créditos por empresa</h2>
          <Input aria-label="Buscar empresa" type="search" placeholder="Buscar empresa…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-[260px]" />
        </div>
        {q.isLoading ? <Spinner label="Cargando empresas" /> : null}
        {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los créditos.')}</Alert> : null}
        {q.data && q.data.items.length === 0 ? <p className="text-[13px] text-muted">No hay empresas que coincidan.</p> : null}
        {q.data && q.data.items.length > 0 ? (
          <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
            <table aria-label="Créditos por empresa" className="w-full text-left text-[13px]">
              <thead className="text-[12px] text-muted"><tr><th className="p-3">Empresa</th><th className="p-3">Saldo</th><th className="p-3">Apartado</th><th className="p-3">Entradas</th><th className="p-3">Usados</th><th className="p-3">Margen</th><th className="p-3"><span className="sr-only">Acciones</span></th></tr></thead>
              <tbody className="divide-y divide-line">
                {q.data.items.map((o) => (
                  <tr key={o.id}>
                    <th scope="row" className="p-3 font-semibold">{o.name}</th>
                    <td className="p-3">{n(o.balance)}</td>
                    <td className="p-3">{n(o.held)}</td>
                    <td className="p-3">{n(o.granted)}</td>
                    <td className="p-3">{n(o.used)}</td>
                    <td className="p-3">{num(o.margin_pct)} %{o.margin_override ? <> <Pill kind="accent">propio</Pill></> : null}</td>
                    <td className="p-3"><div className="flex flex-wrap gap-1.5">
                      <Button className={SMALL} aria-label={`Regalar créditos a ${o.name}`} onClick={() => setDialog({ kind: 'grant', org: o })}>Regalar</Button>
                      <Button className={SMALL} aria-label={`Margen de ${o.name}`} onClick={() => setDialog({ kind: 'margin', org: o })}>Margen</Button>
                      <Button className={SMALL} aria-label={`Movimientos de ${o.name}`} onClick={() => setDialog({ kind: 'ledger', org: o })}>Movimientos</Button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      {dialog?.kind === 'grant' ? <GrantDialog org={dialog.org} onClose={close} /> : null}
      {dialog?.kind === 'margin' ? <MarginDialog org={dialog.org} onClose={close} /> : null}
      {dialog?.kind === 'ledger' ? <LedgerDialog org={dialog.org} onClose={close} /> : null}
    </div>
  );
}
