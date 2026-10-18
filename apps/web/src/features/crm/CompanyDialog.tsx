import { useEffect, useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import { COUNTRIES, normalizePhone } from '../../lib/phone';
import type { CrmCompany, OwnerOption } from '../../lib/types';
import { isEmail, normalizeEmail } from '../../lib/validation';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { NO_CONTACT_FILTERS, useContacts } from '../contacts/useContacts';
import { NotesPanel } from './NotesPanel';
import { Tabs } from './Tabs';
import { TasksPanel } from './TasksPanel';
import { useCompanyContacts, useCreateCompany, useDeleteCompany, useLinkContacts, useUnlinkContacts, useUpdateCompany, type CompanyInput } from './useCrm';

const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal';
type Tab = 'data' | 'contacts' | 'notes' | 'tasks';

/**
 * Alta y ficha de una empresa (M3.6, ADR-48): datos, sus contactos (los que la persona puede ver), notas y tareas. Los datos y los contactos los cambia solo
 * quien administra (`canManage`); las notas y tareas, cualquiera con `canWrite`. Los permisos solo muestran u ocultan botones; el servidor decide.
 */
export function CompanyDialog({ company, canManage, canWrite, viewAll, owners, onClose }: { company?: CrmCompany; canManage: boolean; canWrite: boolean; viewAll: boolean; owners: OwnerOption[]; onClose: () => void }) {
  const editing = Boolean(company);
  const [tab, setTab] = useState<Tab>('data');
  const [name, setName] = useState(company?.name ?? '');
  const [website, setWebsite] = useState(company?.website ?? '');
  const [phone, setPhone] = useState(company?.phone ?? '');
  const [prefix, setPrefix] = useState<string>(COUNTRIES[0].code);
  const [email, setEmail] = useState(company?.email ?? '');
  const [errors, setErrors] = useState<{ name?: string; website?: string; phone?: string; email?: string }>({});
  const [formError, setFormError] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const create = useCreateCompany();
  const update = useUpdateCompany();
  const remove = useDeleteCompany();
  const busy = create.isPending || update.isPending;
  const readOnly = !canManage;

  function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(undefined);
    const next: typeof errors = {};
    const n = name.trim();
    if (n === '') next.name = 'Escribe el nombre';
    else if (n.length > 120) next.name = 'Usa como máximo 120 caracteres';
    const web = website.trim();
    if (web.length > 200) next.website = 'Usa como máximo 200 caracteres';
    else if (/\s/.test(web)) next.website = 'No puede tener espacios';
    let phoneE164: string | null = null;
    if (phone.trim() !== '') {
      phoneE164 = normalizePhone(phone, prefix);
      if (!phoneE164) next.phone = 'Número no válido: usa de 8 a 15 dígitos (con el prefijo del país o «+»)';
    }
    const em = normalizeEmail(email);
    if (em !== '' && !isEmail(em)) next.email = 'Escribe un correo válido';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const input: CompanyInput = { name: n, website: web === '' ? null : web, phone: phoneE164, email: em === '' ? null : em };
    const fail = (err: unknown) => {
      if ((err as { code?: string }).code === 'COMPANY_EXISTS') {
        setErrors({ name: 'Ya existe una empresa con ese nombre' });
        return;
      }
      setFormError(friendlyError(err, editing ? 'No pudimos guardar los cambios.' : 'No pudimos crear la empresa.'));
    };
    if (company) update.mutate({ id: company.id, input }, { onSuccess: onClose, onError: fail });
    else create.mutate(input, { onSuccess: onClose, onError: fail });
  }

  const heading = editing ? 'Empresa' : 'Nueva empresa';
  return (
    <Modal title={heading} onClose={onClose} wide>
      {readOnly ? <Alert kind="info">{canWrite ? 'Solo el administrador cambia los datos de la empresa y sus contactos. Tú puedes escribir notas y tareas.' : 'Estás en modo solo lectura: puedes ver esta empresa, no cambiarla.'}</Alert> : null}
      {company ? <Tabs<Tab> label="Secciones de la empresa" active={tab} onChange={setTab} tabs={[['data', 'Datos'], ['contacts', `Contactos · ${company.contact_count}`], ['notes', 'Notas'], ['tasks', 'Tareas']]} /> : null}
      {company && tab === 'contacts' ? <CompanyContacts company={company} canWrite={canManage} /> : null}
      {company && tab === 'notes' ? <NotesPanel target={{ kind: 'company', id: company.id }} canWrite={canWrite} /> : null}
      {company && tab === 'tasks' ? <TasksPanel link={{ company: { id: company.id, name: company.name } }} canWrite={canWrite} viewAll={viewAll} owners={owners} /> : null}
      <form onSubmit={submit} noValidate className={`grid gap-3 ${tab === 'data' ? '' : 'hidden'}`} aria-label={heading}>
        <Field label="Nombre" error={errors.name}>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" disabled={readOnly} autoFocus={!editing} />}
        </Field>
        <Field label="Sitio web" error={errors.website} hint="Opcional.">
          {(p) => <Input {...p} value={website} onChange={(e) => setWebsite(e.target.value)} inputMode="url" autoComplete="off" disabled={readOnly} placeholder="www.empresa.com" />}
        </Field>
        <div className="grid gap-3 min-[520px]:grid-cols-2">
          <Field label="Teléfono" error={errors.phone} hint="Opcional.">
            {(p) => (
              <span className="flex gap-2">
                <select aria-label="País del teléfono" value={prefix} onChange={(e) => setPrefix(e.target.value)} className={selectCls} disabled={readOnly}>
                  {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
                </select>
                <Input {...p} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="off" disabled={readOnly} />
              </span>
            )}
          </Field>
          <Field label="Correo" error={errors.email} hint="Opcional.">
            {(p) => <Input {...p} type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" disabled={readOnly} />}
          </Field>
        </div>
        {formError ? <Alert>{formError}</Alert> : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {editing && canManage ? (
            confirm ? (
              <span className="flex items-center gap-2 text-[13px]">¿Borrar esta empresa? Los contactos no se borran.
                <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" loading={remove.isPending} onClick={() => remove.mutate(company!.id, { onSuccess: onClose, onError: (err) => { setConfirm(false); setFormError(friendlyError(err, 'No pudimos borrar la empresa.')); } })}>Sí, borrar</Button>
                <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirm(false)}>No</Button>
              </span>
            ) : <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirm(true)}>Borrar empresa</Button>
          ) : <span />}
          <span className="flex gap-2">
            <Button onClick={onClose}>{readOnly ? 'Cerrar' : 'Cancelar'}</Button>
            {!readOnly ? <Button type="submit" variant="primary" loading={busy}>{editing ? 'Guardar' : 'Crear empresa'}</Button> : null}
          </span>
        </div>
      </form>
      {tab !== 'data' ? <div className="flex justify-end"><Button onClick={onClose}>Cerrar</Button></div> : null}
    </Modal>
  );
}

/** Contactos de la empresa que la persona puede ver, con búsqueda para agregar más. */
function CompanyContacts({ company, canWrite }: { company: CrmCompany; canWrite: boolean }) {
  const members = useCompanyContacts(company.id);
  const link = useLinkContacts();
  const unlink = useUnlinkContacts();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const search = useContacts({ ...NO_CONTACT_FILTERS, q }, undefined);
  const list = members.data?.pages.flatMap((p) => p.items) ?? [];
  const linked = new Set(list.map((c) => c.id));
  const candidates = q === '' ? [] : (search.data?.pages[0]?.items ?? []).filter((c) => !linked.has(c.id)).slice(0, 8);

  return (
    <section aria-label="Contactos de la empresa" className="grid gap-3">
      {canWrite ? (
        <div className="grid gap-2">
          <label className="grid gap-1 text-[12px] font-semibold">Agregar contactos
            <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Busca por nombre, correo o teléfono" className="rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px] font-normal" />
          </label>
          <ul className="grid gap-1">
            {candidates.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-1.5 text-[13px]">
                <span className="truncate">{c.name}</span>
                <Button className="!px-3 !py-1 !text-[12px]" aria-label={`Agregar a ${c.name}`} onClick={() => { setError(undefined); setNotice(undefined); link.mutate({ companyId: company.id, ids: [c.id] }, { onSuccess: (r) => { if (r.added === 0) setNotice('No se pudo agregar: el contacto ya está o llegó al máximo de 5 empresas.'); }, onError: (e) => setError(friendlyError(e, 'No pudimos agregar el contacto.')) }); }}>Agregar</Button>
              </li>
            ))}
          </ul>
          {q !== '' && search.isSuccess && candidates.length === 0 ? <p className="text-[12.5px] text-muted">Ningún contacto nuevo coincide.</p> : null}
        </div>
      ) : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      {members.isPending ? <div className="grid place-items-center py-4 text-muted"><Spinner label="Cargando contactos" /></div> : null}
      {members.isError ? <Alert>{friendlyError(members.error, 'No pudimos cargar los contactos.')}</Alert> : null}
      {members.isSuccess && list.length === 0 ? <p className="rounded-xl border border-dashed border-line p-4 text-center text-[13px] text-muted">No hay contactos que puedas ver en esta empresa.</p> : null}
      <ul className="grid gap-2">
        {list.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-[13.5px]">
            <span className="min-w-0"><b className="block truncate">{c.name}</b><span className="text-[12px] text-muted">{[c.phone, c.email].filter(Boolean).join(' · ')}</span></span>
            {canWrite ? <Button className="!px-3 !py-1 !text-[12px]" aria-label={`Quitar a ${c.name} de la empresa`} onClick={() => { setError(undefined); unlink.mutate({ companyId: company.id, ids: [c.id] }, { onError: (e) => setError(friendlyError(e, 'No pudimos quitar el contacto.')) }); }}>Quitar</Button> : null}
          </li>
        ))}
      </ul>
      {members.hasNextPage ? <div><Button loading={members.isFetchingNextPage} onClick={() => void members.fetchNextPage()}>Cargar más</Button></div> : null}
    </section>
  );
}
