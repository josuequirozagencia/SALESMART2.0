import type { ReactNode } from 'react';

export type PillKind = 'ok' | 'warn' | 'crit' | 'info' | 'muted' | 'accent';

const CLS: Record<PillKind, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  crit: 'bg-crit-soft text-crit',
  info: 'bg-info-soft text-info',
  muted: 'bg-surface2 text-muted',
  accent: 'bg-accent-soft text-accent',
};

export function Pill({ kind, children }: { kind: PillKind; children: ReactNode }) {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold ${CLS[kind]}`}>{children}</span>;
}
