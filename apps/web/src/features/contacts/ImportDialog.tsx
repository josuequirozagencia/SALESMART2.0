import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { saveBlob } from '../../lib/api';
import { batchesOf, decodeBytes, guessTarget, readCsv, readFileBytes, sha256Hex, type ParsedCsv } from '../../lib/csv-read';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import { COUNTRIES } from '../../lib/phone';
import type { ContactImport, ImportOptions, ImportStatus } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useCustomFields } from '../custom-fields/useCustomFields';
import { useTags } from '../tags/useTags';
import { useOwners } from './useContacts';
import { cancelImport, createImport, getImport, importReport, patchImport, processImport, startImport, stageRows, useCancelImport, useImports, usePreview } from './useImports';

type Step = 'file' | 'map' | 'review' | 'run';
const STATUS_LABEL: Record<ImportStatus, string> = { staging: 'Subiendo', ready: 'Lista para revisar', running: 'En curso', done: 'Terminada', cancelled: 'Cancelada' };
const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px]';
const FIXED_TARGETS = [['ignore', 'No importar'], ['name', 'Nombre'], ['phone', 'Teléfono'], ['email', 'Correo']] as const;

/**
 * Importar contactos desde un CSV (M3.5, ADR-47). El navegador lee el archivo y manda las filas por lotes; el servidor las valida con las mismas reglas que
 * usará al importar (vista previa) y procesa de 200 en 200. Si se corta, se retoma desde el historial. XLSX no: se guarda como CSV desde Excel.
 */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const fieldsQ = useCustomFields();
  const tagsQ = useTags();
  const owners = useOwners(true);
  const history = useImports(true);
  const cancel = useCancelImport();
  const fields = useMemo(() => (fieldsQ.data?.items ?? []).filter((f) => f.archived_at === null), [fieldsQ.data]);
  const customTags = useMemo(() => (tagsQ.data?.items ?? []).filter((t) => !t.is_system), [tagsQ.data]);

  const [step, setStep] = useState<Step>('file');
  const [file, setFile] = useState<{ name: string; hash: string; csv: ParsedCsv } | null>(null);
  const [mapping, setMapping] = useState<string[]>([]);
  const [imp, setImp] = useState<ContactImport | null>(null);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [legal, setLegal] = useState(false);
  const [paused, setPaused] = useState(false);
  const running = useRef(false);

  const preview = usePreview(step === 'review' ? (imp?.id ?? null) : null, imp?.options.country_prefix ?? '');
  const refresh = () => qc.invalidateQueries({ queryKey: ['contact-imports'] });

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setError(undefined);
    setBusy('Leyendo el archivo…');
    try {
      const bytes = await readFileBytes(f);
      const r = readCsv(decodeBytes(bytes));
      if (!r.ok) return setError(r.error);
      const taken = new Set<string>();
      const guess = r.csv.headers.map((h) => {
        const t = guessTarget(h, fields, taken);
        if (t !== 'ignore') taken.add(t);
        return t;
      });
      setFile({ name: f.name, hash: await sha256Hex(bytes), csv: r.csv });
      setMapping(guess);
      setStep('map');
    } catch {
      setError('No pudimos leer el archivo. Guárdalo como CSV (UTF-8) e inténtalo de nuevo.');
    } finally {
      setBusy(undefined);
    }
  }

  function setTarget(i: number, value: string) {
    setMapping((m) => m.map((t, j) => (j === i ? value : t === value && value !== 'ignore' ? 'ignore' : t))); // un destino solo puede estar en una columna
  }

  async function upload() {
    if (!file) return;
    setError(undefined);
    let createdId: string | null = null;
    try {
      setBusy('Preparando la importación…');
      const total = file.csv.rows.length;
      let cur = await createImport({ file_name: file.name, file_hash: file.hash, total_rows: total, headers: file.csv.headers, mapping });
      createdId = cur.id;
      setImp(cur);
      for (const b of batchesOf(file.csv.rows)) {
        setBusy(`Subiendo filas… ${Math.min(b.from - 1, total)} de ${total}`);
        cur = await stageRows(cur.id, b.from, b.rows);
        setImp(cur);
      }
      setStep('review');
      void refresh();
    } catch (e) {
      // Una subida a medias no debe bloquear el reintento del mismo archivo (la huella queda ocupada hasta cancelarla)
      if (createdId) await cancelImport(createdId).catch(() => undefined);
      setImp(null);
      setError(friendlyError(e, 'No pudimos subir el archivo.'));
    } finally {
      setBusy(undefined);
    }
  }

  async function changeOptions(patch: Partial<ImportOptions>) {
    if (!imp) return;
    setError(undefined);
    try {
      setImp(await patchImport(imp.id, patch));
    } catch (e) {
      setError(friendlyError(e, 'No pudimos cambiar las opciones.'));
    }
  }

  async function begin() {
    if (!imp) return;
    setError(undefined);
    setBusy('Empezando…');
    try {
      setImp(await startImport(imp.id, imp.options.consent === 'granted' && legal));
      setStep('run');
      setPaused(false);
    } catch (e) {
      setError(friendlyError(e, 'No pudimos empezar la importación.'));
    } finally {
      setBusy(undefined);
    }
  }

  // La pantalla conduce el proceso: pide un lote tras otro hasta terminar. Si falla, se detiene y se ofrece «Continuar» (es reanudable).
  useEffect(() => {
    if (step !== 'run' || !imp || imp.status !== 'running' || paused || running.current) return;
    running.current = true;
    let live = true;
    void (async () => {
      try {
        const next = await processImport(imp.id);
        if (live) setImp(next);
        if (next.status === 'done') {
          void qc.invalidateQueries({ queryKey: ['contacts'] });
          void qc.invalidateQueries({ queryKey: ['contact-imports'] });
        }
      } catch (e) {
        if (live) {
          setPaused(true);
          setError(friendlyError(e, 'Se interrumpió la importación. Puedes continuar desde donde quedó.'));
        }
      } finally {
        running.current = false;
      }
    })();
    return () => { live = false; };
  }, [step, imp, paused, qc]);

  async function resume(h: ContactImport) {
    setError(undefined);
    setLegal(false);
    setImp(h);
    setPaused(false);
    if (h.status === 'ready') setStep('review');
    else if (h.status === 'running') setStep('run');
  }

  async function report(id: string) {
    try {
      saveBlob(await importReport(id));
    } catch (e) {
      setError(friendlyError(e, 'No pudimos descargar el reporte.'));
    }
  }

  async function reload() {
    if (!imp) return;
    try {
      setImp(await getImport(imp.id));
    } catch {
      /* se mantiene lo que había */
    }
  }

  const phoneCols = mapping.filter((t) => t === 'phone').length;
  const sample = file?.csv.rows.slice(0, 3) ?? [];
  const importable = preview.data ? preview.data.new + (imp?.options.duplicates === 'update_empty' ? preview.data.duplicates_existing : 0) : 0;
  const recent = (history.data ?? []).slice(0, 5);

  return (
    <Modal title="Importar contactos" onClose={onClose} wide>
      {step === 'file' ? (
        <div className="grid gap-3">
          <p className="text-[13.5px] text-muted">Sube un archivo CSV con tus contactos (si lo tienes en Excel, usa «Guardar como… CSV»). Máximo 5 000 filas por archivo.</p>
          <label className="grid gap-1 text-[12px] font-semibold">Archivo CSV
            <input type="file" accept=".csv,text/csv" onChange={(e) => void pick(e)} disabled={busy !== undefined} className="rounded-[10px] border border-dashed border-line bg-surface px-3 py-4 text-[13px] font-normal" />
          </label>
          {recent.length > 0 ? (
            <div className="grid gap-1.5">
              <h3 className="text-[13px] font-bold">Importaciones recientes</h3>
              <ul className="grid gap-1.5">
                {recent.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-line px-3 py-2 text-[12.5px]">
                    <span><b>{h.file_name}</b> · {STATUS_LABEL[h.status]} · {shortDateTime(h.created_at)}
                      {h.status === 'done' ? <span className="text-muted"> · {h.counts.created} nuevos, {h.counts.updated} actualizados, {h.counts.skipped} omitidos, {h.counts.rejected} rechazados</span> : null}
                    </span>
                    <span className="flex items-center gap-2">
                      {h.status === 'ready' || h.status === 'running' ? <Button variant="link" onClick={() => void resume(h)}>Continuar</Button> : null}
                      {(h.status === 'ready' || h.status === 'staging') ? <Button variant="link" onClick={() => void cancel.mutateAsync(h.id)}>Cancelar</Button> : null}
                      {h.status === 'done' && h.counts.skipped + h.counts.rejected > 0 ? <Button variant="link" onClick={() => void report(h.id)}>Descargar reporte</Button> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {step === 'map' && file ? (
        <div className="grid gap-3">
          <p className="text-[13.5px]"><b>{file.name}</b> · {file.csv.rows.length} filas · {file.csv.headers.length} columnas. Elige qué es cada columna; el teléfono es obligatorio.</p>
          <div className="overflow-x-auto rounded-[10px] border border-line">
            <table className="w-full text-left text-[12.5px]">
              <thead className="bg-surface2 text-muted"><tr><th className="px-3 py-2">Columna del archivo</th><th className="px-3 py-2">Ejemplo</th><th className="px-3 py-2">Importar como</th></tr></thead>
              <tbody>
                {file.csv.headers.map((h, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="px-3 py-2 font-semibold">{h}</td>
                    <td className="max-w-[180px] truncate px-3 py-2 text-muted">{sample.map((r) => r[i]).filter(Boolean).join(' · ')}</td>
                    <td className="px-3 py-2">
                      <select aria-label={`Destino de «${h}»`} value={mapping[i] ?? 'ignore'} onChange={(e) => setTarget(i, e.target.value)} className={selectCls}>
                        {FIXED_TARGETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        {fields.map((f) => <option key={f.key} value={`cf:${f.key}`}>Campo: {f.name}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {phoneCols !== 1 ? <Alert kind="info">Elige exactamente una columna como «Teléfono».</Alert> : null}
          {error ? <Alert>{error}</Alert> : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button onClick={() => { setStep('file'); setError(undefined); }} disabled={busy !== undefined}>Cambiar archivo</Button>
            <Button variant="primary" disabled={phoneCols !== 1} loading={busy !== undefined} onClick={() => void upload()}>{busy ?? 'Revisar'}</Button>
          </div>
        </div>
      ) : null}

      {step === 'review' && imp ? (
        <div className="grid gap-3">
          <p className="text-[13.5px]"><b>{imp.file_name}</b> · {imp.total_rows} filas</p>
          {preview.isPending ? <div className="grid place-items-center py-4 text-muted"><Spinner label="Revisando el archivo" /></div> : null}
          {preview.isError ? <Alert>{friendlyError(preview.error, 'No pudimos revisar el archivo.')}</Alert> : null}
          {preview.data ? (
            <div className="grid gap-2">
              <ul className="grid grid-cols-2 gap-2 text-[13px] min-[560px]:grid-cols-4">
                <li className="rounded-[10px] bg-ok-soft px-3 py-2"><b className="block text-[18px]">{preview.data.new}</b>nuevos</li>
                <li className="rounded-[10px] bg-info-soft px-3 py-2"><b className="block text-[18px]">{preview.data.duplicates_existing}</b>ya existen</li>
                <li className="rounded-[10px] bg-info-soft px-3 py-2"><b className="block text-[18px]">{preview.data.duplicates_in_file}</b>repetidos en el archivo</li>
                <li className="rounded-[10px] bg-crit-soft px-3 py-2"><b className="block text-[18px]">{preview.data.invalid}</b>con errores</li>
              </ul>
              {preview.data.samples.length > 0 ? (
                <details className="text-[12.5px]">
                  <summary className="cursor-pointer font-semibold">Ver filas con errores</summary>
                  <ul className="mt-1 grid gap-0.5 text-muted">
                    {preview.data.samples.map((s) => <li key={s.row_no}>Fila {s.row_no + 1}: {s.reasons.join(', ')}</li>)}
                  </ul>
                </details>
              ) : null}
            </div>
          ) : null}

          <fieldset className="grid gap-2 rounded-[10px] border border-line p-3">
            <legend className="px-1 text-[12px] font-semibold">Opciones</legend>
            <label className="grid gap-1 text-[12px] font-semibold">País de los teléfonos sin «+»
              <select aria-label="País de los teléfonos" value={imp.options.country_prefix} onChange={(e) => void changeOptions({ country_prefix: e.target.value })} className={`${selectCls} font-normal`}>
                {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-[12px] font-semibold">Si el teléfono ya existe
              <select aria-label="Si el teléfono ya existe" value={imp.options.duplicates} onChange={(e) => void changeOptions({ duplicates: e.target.value as ImportOptions['duplicates'] })} className={`${selectCls} font-normal`}>
                <option value="skip">Omitir esa fila</option>
                <option value="update_empty">Completar solo los datos que le faltan</option>
              </select>
            </label>
            <label className="grid gap-1 text-[12px] font-semibold">Consentimiento de estos contactos
              <select aria-label="Consentimiento" value={imp.options.consent} onChange={(e) => { setLegal(false); void changeOptions({ consent: e.target.value as ImportOptions['consent'] }); }} className={`${selectCls} font-normal`}>
                <option value="unknown">Sin definir</option>
                <option value="granted">Con consentimiento</option>
              </select>
            </label>
            {imp.options.consent === 'granted' ? (
              <label className="flex items-start gap-2 text-[12.5px]">
                <input type="checkbox" checked={legal} onChange={(e) => setLegal(e.target.checked)} className="mt-0.5" />
                Confirmo que tengo una base legal para tratar y contactar a estas personas (por ejemplo, su autorización). Queda registrado.
              </label>
            ) : null}
            <label className="grid gap-1 text-[12px] font-semibold">Etiqueta para los contactos importados
              <select aria-label="Etiqueta" value={imp.options.tag_id ?? ''} onChange={(e) => void changeOptions({ tag_id: e.target.value || null })} className={`${selectCls} font-normal`}>
                <option value="">Ninguna</option>
                {customTags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-[12px] font-semibold">Responsable
              <select aria-label="Responsable de los importados" value={imp.options.owner_id ?? ''} onChange={(e) => void changeOptions({ owner_id: e.target.value || null })} className={`${selectCls} font-normal`}>
                <option value="">Sin asignar</option>
                {(owners.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </label>
          </fieldset>
          <p className="text-[12px] text-muted">Importar no envía eventos a Meta ni agrega la etiqueta «Lead». Los campos obligatorios no se exigen al importar.</p>
          {error ? <Alert>{error}</Alert> : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button onClick={() => { void cancel.mutateAsync(imp.id); setImp(null); setFile(null); setStep('file'); setError(undefined); }}>Cancelar importación</Button>
            <Button variant="primary" loading={busy !== undefined} disabled={!preview.data || importable === 0 || (imp.options.consent === 'granted' && !legal)} onClick={() => void begin()}>
              {importable > 0 ? `Importar ${importable} contacto${importable === 1 ? '' : 's'}` : 'No hay nada para importar'}
            </Button>
          </div>
        </div>
      ) : null}

      {step === 'run' && imp ? (
        <div className="grid gap-3">
          <p className="text-[13.5px]"><b>{imp.file_name}</b></p>
          {imp.status === 'done' ? (
            <div className="grid gap-2">
              <Alert kind="ok">Importación terminada.</Alert>
              <ul className="grid grid-cols-2 gap-2 text-[13px] min-[560px]:grid-cols-4">
                <li className="rounded-[10px] bg-ok-soft px-3 py-2"><b className="block text-[18px]">{imp.counts.created}</b>creados</li>
                <li className="rounded-[10px] bg-info-soft px-3 py-2"><b className="block text-[18px]">{imp.counts.updated}</b>actualizados</li>
                <li className="rounded-[10px] bg-info-soft px-3 py-2"><b className="block text-[18px]">{imp.counts.skipped}</b>omitidos</li>
                <li className="rounded-[10px] bg-crit-soft px-3 py-2"><b className="block text-[18px]">{imp.counts.rejected}</b>rechazados</li>
              </ul>
              {imp.counts.skipped + imp.counts.rejected > 0 ? <div><Button onClick={() => void report(imp.id)}>Descargar reporte de omitidos y rechazados</Button></div> : null}
            </div>
          ) : (
            <div className="grid gap-2" aria-live="polite">
              <progress className="w-full" max={imp.total_rows} value={imp.total_rows - imp.counts.pending} aria-label="Avance de la importación" />
              <p className="text-[12.5px] text-muted">{imp.total_rows - imp.counts.pending} de {imp.total_rows} filas procesadas. No cierres esta ventana hasta que termine; si se corta, puedes continuar desde «Importaciones recientes».</p>
              {paused ? <div><Button variant="primary" onClick={() => { setError(undefined); setPaused(false); void reload(); }}>Continuar</Button></div> : <Spinner label="Importando" />}
            </div>
          )}
          {error ? <Alert>{error}</Alert> : null}
          <div className="flex justify-end"><Button variant={imp.status === 'done' ? 'primary' : 'secondary'} onClick={onClose}>{imp.status === 'done' ? 'Listo' : 'Cerrar'}</Button></div>
        </div>
      ) : null}

      {step === 'file' && error ? <Alert>{error}</Alert> : null}
      {step === 'file' && busy ? <p className="text-[12.5px] text-muted" aria-live="polite">{busy}</p> : null}
      {step === 'file' ? <div className="flex justify-end"><Button onClick={onClose}>Cerrar</Button></div> : null}
    </Modal>
  );
}
