import { useId, useState, type ComponentPropsWithRef, type InputHTMLAttributes, type ReactNode } from 'react';

const cx = (...c: Array<string | false | undefined>): string => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'danger' | 'link';
export function Button({ variant = 'secondary', block, className, loading, children, disabled, ...rest }: ComponentPropsWithRef<'button'> & { variant?: Variant; block?: boolean; loading?: boolean }) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-[10px] text-[14px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-60';
  const styles: Record<Variant, string> = {
    primary: 'bg-accent text-accent-ink border border-accent px-4 py-3 hover:brightness-110',
    secondary: 'bg-surface text-fg border border-line px-4 py-3 hover:bg-surface2',
    danger: 'bg-crit-soft text-crit border border-transparent px-4 py-3 hover:brightness-95',
    link: 'bg-transparent border-0 p-0 text-accent text-[length:inherit] font-semibold hover:underline',
  };
  return (
    <button type="button" className={cx(base, styles[variant], block && 'w-full', className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span role={label ? 'status' : undefined} aria-label={label} className="inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
  );
}

/** Campo con etiqueta, ayuda y error asociados (aria-describedby / aria-invalid). */
export function Field({ label, error, hint, children }: { label: string; error?: string | undefined; hint?: string; children: (p: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string }) => ReactNode }) {
  const id = useId();
  const msgId = `${id}-msg`;
  return (
    <div className="grid gap-[5px] text-[12.5px] font-semibold">
      <label htmlFor={id}>{label}</label>
      {children({ id, ...(error ? { 'aria-invalid': true as const } : {}), ...(error || hint ? { 'aria-describedby': msgId } : {}) })}
      {error ? <span id={msgId} role="alert" className="text-[12px] font-medium text-crit">{error}</span> : hint ? <span id={msgId} className="text-[12px] font-normal text-muted">{hint}</span> : null}
    </div>
  );
}

const inputCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg placeholder:text-muted/70 aria-[invalid=true]:border-crit';
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputCls, props.className)} />;
}

export function PasswordInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false);
  return (
    <span className="relative block">
      <input {...props} type={shown ? 'text' : 'password'} className={cx(inputCls, 'pr-11', props.className)} />
      <button type="button" onClick={() => setShown((s) => !s)} aria-label={shown ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={shown} className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-muted hover:text-fg">
        <EyeIcon off={shown} />
      </button>
    </span>
  );
}

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'ok' | 'info'; children: ReactNode }) {
  const styles = { error: 'bg-crit-soft text-crit', ok: 'bg-ok-soft text-ok', info: 'bg-info-soft text-info' } as const;
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={cx('rounded-[10px] px-3 py-2.5 text-[13px] font-medium', styles[kind])}>
      {children}
    </div>
  );
}

export function EyeIcon({ off }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {off ? <path d="M3 3l18 18" /> : null}
    </svg>
  );
}

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
