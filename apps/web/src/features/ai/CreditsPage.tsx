import { friendlyError } from '../../lib/errors';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { SettingsNav } from '../app/SettingsNav';
import { KIND_LABEL, useAiCredits, type LedgerItem } from './useAiCredits';

const n = (v: number): string => v.toLocaleString('es-EC');
const when = (iso: string): string => new Date(iso).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });

function Row({ i }: { i: LedgerItem }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2.5 text-[13.5px]">
      <Pill kind={i.credits > 0 ? 'ok' : 'muted'}>{KIND_LABEL[i.kind]}</Pill>
      <b className={i.credits > 0 ? 'text-ok' : ''}>{i.credits > 0 ? '+' : '−'}{n(Math.abs(i.credits))}</b>
      <span className="min-w-0 flex-1 text-muted">{i.ref ?? ''}</span>
      <span className="text-[12px] text-muted">Saldo {n(i.balance_after)} · {when(i.created_at)}</span>
    </li>
  );
}

/** Configuración › Créditos IA (M8.1, ADR-19/53): saldo y movimientos de la empresa. Solo créditos: el costo, el margen y el proveedor no existen para el cliente. */
export function CreditsPage() {
  const q = useAiCredits();
  const first = q.data?.pages[0];
  const items = (q.data?.pages ?? []).flatMap((p) => p.items);
  return (
    <div className="grid gap-4">
      <SettingsNav />
      <section aria-label="Créditos IA" className="grid gap-4">
        <p className="max-w-[70ch] text-[13px] text-muted">Los créditos pagan lo que hacen los agentes de IA y sus pruebas. El saldo sube con los créditos de bienvenida y los regalos, y baja con cada uso.</p>
        {q.isLoading ? <Spinner label="Cargando créditos" /> : null}
        {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar tus créditos.')}</Alert> : null}
        {first ? (
          <>
            <dl className="grid grid-cols-1 gap-3 min-[560px]:grid-cols-3">
              <div className="rounded-2xl border border-line bg-surface p-4"><dt className="text-[12px] font-semibold text-muted">Saldo</dt><dd className="text-[26px] font-bold">{n(first.balance)}</dd></div>
              <div className="rounded-2xl border border-line bg-surface p-4"><dt className="text-[12px] font-semibold text-muted">Apartado ahora</dt><dd className="text-[26px] font-bold">{n(first.held)}</dd></div>
              <div className="rounded-2xl border border-line bg-surface p-4"><dt className="text-[12px] font-semibold text-muted">Disponible</dt><dd className="text-[26px] font-bold">{n(first.available)}</dd></div>
            </dl>
            {first.available === 0 ? <Alert kind="info">No te quedan créditos disponibles: los agentes de IA se pausarán hasta que haya saldo. Pide más créditos a tu proveedor.</Alert> : null}
            <div>
              <h2 className="text-[14px] font-bold">Movimientos</h2>
              {items.length === 0 ? <p className="py-2 text-[13px] text-muted">Aún no hay movimientos.</p> : <ul aria-label="Movimientos de créditos" className="divide-y divide-line">{items.map((i) => <Row key={i.id} i={i} />)}</ul>}
              {q.hasNextPage ? <div className="pt-2"><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Ver más movimientos</Button></div> : null}
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
