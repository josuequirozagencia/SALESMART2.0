import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import { Alert, Button, Input, Spinner } from '../../ui/controls';
import { Pill, type PillKind } from '../../ui/Pill';
import { SettingsNav } from '../app/SettingsNav';
import { useKnowledgeDocs, useKnowledgeMutations, useUploadDocument, type DocStatus, type KnowledgeDoc, type SearchHit } from './useKnowledge';

const SMALL = '!px-3 !py-1.5 !text-[12.5px]';
const KIND_LABEL = { txt: 'Texto', csv: 'Tabla', pdf: 'PDF', docx: 'Word' } as const;
const ACCEPT = '.pdf,.docx,.txt,.md,.csv';
const mb = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Estado de un documento en palabras de la persona. «Esperando» = no hay servicio de IA configurado todavía; se procesará solo. */
function statusOf(d: KnowledgeDoc): { kind: PillKind; label: string } {
  if (d.status === 'pending' && d.error_code === 'waiting') return { kind: 'warn', label: 'Esperando a la IA' };
  const map: Record<DocStatus, { kind: PillKind; label: string }> = { pending: { kind: 'muted', label: 'En fila' }, processing: { kind: 'info', label: 'Procesando' }, ready: { kind: 'ok', label: 'Listo' }, error: { kind: 'crit', label: 'Con error' } };
  return map[d.status];
}

function DocRow({ d }: { d: KnowledgeDoc }) {
  const { setActive, reprocess, remove } = useKnowledgeMutations();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const st = statusOf(d);
  const fail = (e: unknown): void => setError(friendlyError(e, 'No pudimos completar la acción.'));
  return (
    <li className="grid gap-1.5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="min-w-0 flex-1 truncate font-semibold" title={d.name}>{d.name}</span>
        <Pill kind={st.kind}>{st.label}</Pill>
        <span className="text-[12px] text-muted">{KIND_LABEL[d.kind]} · {mb(d.size_bytes)}{d.status === 'ready' ? ` · ${d.chunk_count} ${d.chunk_count === 1 ? 'fragmento' : 'fragmentos'}` : ''}</span>
      </div>
      {d.error_message ? <p className={`text-[12.5px] ${d.status === 'error' ? 'text-crit' : 'text-muted'}`}>{d.error_message}</p> : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-2 text-[12.5px] font-semibold">
          <input type="checkbox" checked={d.active} disabled={setActive.isPending} aria-label={`Usar «${d.name}» en las respuestas`} onChange={(e) => { setError(undefined); setActive.mutate({ id: d.id, active: e.target.checked }, { onError: fail }); }} />
          Usar en las respuestas
        </label>
        {d.can_reprocess ? <Button className={SMALL} loading={reprocess.isPending} aria-label={`Reprocesar «${d.name}»`} onClick={() => { setError(undefined); reprocess.mutate(d.id, { onError: fail }); }}>Reprocesar</Button> : null}
        {confirm ? (
          <span className="flex flex-wrap items-center gap-2 text-[12.5px]">
            ¿Borrar este documento?
            <Button variant="danger" className={SMALL} loading={remove.isPending} onClick={() => remove.mutate(d.id, { onError: (e) => { setConfirm(false); fail(e); } })}>Sí, borrar</Button>
            <Button className={SMALL} onClick={() => setConfirm(false)}>No</Button>
          </span>
        ) : (
          <Button className={SMALL} aria-label={`Borrar «${d.name}»`} onClick={() => setConfirm(true)}>Borrar</Button>
        )}
      </div>
    </li>
  );
}

function SearchBox() {
  const { search } = useKnowledgeMutations();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (query.trim().length === 0) return setError('Escribe una pregunta.');
    setError(undefined);
    search.mutate(query.trim(), { onSuccess: (r) => setHits(r.hits), onError: (e2) => { setHits(null); setError(friendlyError(e2, 'No pudimos buscar.')); } });
  };
  return (
    <section aria-label="Probar la búsqueda" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
      <h2 className="text-[15px] font-bold">Probar la búsqueda</h2>
      <p className="max-w-[70ch] text-[12.5px] text-muted">Escribe una pregunta como la haría un cliente y mira qué encuentra la IA en tus documentos. Si no encuentra nada parecido, no afirmaría nada sobre eso. Cada búsqueda usa 1 crédito.</p>
      <form onSubmit={submit} noValidate className="flex flex-wrap gap-2">
        <Input aria-label="Pregunta" className="min-w-[220px] flex-1" placeholder="¿Cuál es el horario de atención?" value={query} maxLength={2000} onChange={(e) => setQuery(e.target.value)} />
        <Button type="submit" variant="primary" loading={search.isPending}>Buscar</Button>
      </form>
      {error ? <Alert>{error}</Alert> : null}
      {hits && hits.length === 0 ? <Alert kind="info">No se encontró nada parecido en tus documentos: la IA no respondería con datos sobre esto y ofrecería pasar con una persona.</Alert> : null}
      {hits && hits.length > 0 ? (
        <ul aria-label="Resultados" className="grid gap-2">
          {hits.map((h, i) => (
            <li key={`${h.document.id}-${i}`} className="grid gap-1 rounded-xl border border-line p-3 text-[13px]">
              <span className="flex flex-wrap items-center gap-2"><b>{h.document.name}</b><Pill kind="accent">Parecido {Math.round(h.score * 100)} %</Pill></span>
              <span className="whitespace-pre-line text-muted">{h.content}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Configuración › Conocimiento (M8.2, ADR-53; F16): la biblioteca de documentos de la empresa. Subir, ver el estado, activar, reprocesar, borrar y probar la búsqueda. */
export function KnowledgePage() {
  const q = useKnowledgeDocs();
  const upload = useUploadDocument();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const items = (q.data?.pages ?? []).flatMap((p) => p.items);
  const limits = q.data?.pages[0]?.limits;

  const send = async (files: FileList | File[]): Promise<void> => {
    setErrors([]);
    for (const f of Array.from(files)) {
      try {
        await upload.mutateAsync(f);
      } catch (e) {
        setErrors((cur) => [...cur, `${f.name}: ${friendlyError(e, 'No pudimos subir el archivo.')}`]);
      }
    }
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files.length > 0) void send(e.dataTransfer.files);
  };

  return (
    <div className="grid gap-4">
      <SettingsNav />
      <section aria-label="Biblioteca de conocimiento" className="grid gap-4">
        <p className="max-w-[70ch] text-[13px] text-muted">Sube los documentos con los datos de tu negocio (horarios, precios, políticas, preguntas frecuentes). Los agentes de IA solo responderán con lo que esté aquí. Se procesan solos en unos segundos y cada uno usa unos pocos créditos.</p>
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          className={`grid place-items-center gap-2 rounded-2xl border-2 border-dashed p-6 text-center ${drag ? 'border-accent bg-surface2' : 'border-line bg-surface'}`}
        >
          <p className="text-[13.5px] font-semibold">Arrastra tus archivos aquí</p>
          <p className="text-[12px] text-muted">PDF, Word (.docx), texto (.txt) o tabla (.csv){limits ? `, hasta ${mb(limits.max_bytes)} cada uno` : ''}</p>
          <input ref={input} type="file" accept={ACCEPT} multiple className="sr-only" aria-label="Elegir documentos" onChange={(e) => { if (e.target.files) void send(e.target.files); e.target.value = ''; }} />
          <Button variant="primary" loading={upload.isPending} onClick={() => input.current?.click()}>Subir documentos</Button>
        </div>
        {errors.length > 0 ? <Alert><ul>{errors.map((m) => <li key={m}>{m}</li>)}</ul></Alert> : null}
        {q.isLoading ? <Spinner label="Cargando documentos" /> : null}
        {q.isError ? <Alert>{friendlyError(q.error, 'Solo el administrador de la empresa puede ver y cambiar esto.')}</Alert> : null}
        {limits ? <p className="text-[12px] text-muted">{items.length} {items.length === 1 ? 'documento' : 'documentos'} de {limits.max_documents} · {limits.chunks_used.toLocaleString('es-EC')} de {limits.chunks_max.toLocaleString('es-EC')} fragmentos usados</p> : null}
        {q.data && items.length === 0 ? <p className="text-[13px] text-muted">Aún no hay documentos. Sube el primero para empezar.</p> : null}
        {items.length > 0 ? <ul aria-label="Documentos" className="divide-y divide-line rounded-2xl border border-line bg-surface px-4">{items.map((d) => <DocRow key={d.id} d={d} />)}</ul> : null}
        {q.hasNextPage ? <div><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Ver más documentos</Button></div> : null}
      </section>
      <SearchBox />
    </div>
  );
}
