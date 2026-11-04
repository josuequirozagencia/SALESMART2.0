import { Icon } from './Icon';
import { useTheme } from './theme';

/**
 * Interruptor de modo oscuro para toda la plataforma (ADR-60). Es un `role="switch"`: activado = oscuro. Mientras la elección sea manual aparece «Usar el del sistema»
 * para volver a seguir al aparato. `onDark` lo pinta para la barra lateral (siempre oscura); `compact` deja solo el icono (barra lateral plegada).
 */
export function ThemeSwitch({ onDark = false, compact = false }: { onDark?: boolean; compact?: boolean }) {
  const { mode, effective, setMode } = useTheme();
  const dark = effective === 'dark';
  const label = dark ? 'Modo claro' : 'Modo oscuro';
  const tone = onDark ? 'text-white/85 hover:bg-white/10' : 'text-fg hover:bg-surface2';
  return (
    <div className={`flex min-w-0 items-center gap-1 ${compact ? 'flex-col' : ''}`}>
      <button
        type="button"
        role="switch"
        aria-checked={dark}
        aria-label={label}
        title={label}
        onClick={() => setMode(dark ? 'light' : 'dark')}
        className={`flex min-h-10 min-w-10 items-center gap-2.5 rounded-[10px] px-2.5 text-[13px] font-semibold transition-colors ${tone} ${compact ? 'justify-center' : 'flex-1'}`}
      >
        <Icon name={dark ? 'sun' : 'moon'} size={18} />
        {compact ? null : (
          <>
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            <span aria-hidden="true" className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${dark ? 'bg-accent' : onDark ? 'bg-white/25' : 'bg-line'}`}>
              <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left] duration-150 ${dark ? 'left-[18px]' : 'left-0.5'}`} />
            </span>
          </>
        )}
      </button>
      {mode !== 'system' && !compact ? (
        <button type="button" onClick={() => setMode('system')} title="Seguir el tema del aparato" className={`min-h-10 shrink-0 rounded-[10px] px-2 text-[12px] font-semibold ${onDark ? 'text-white/60 hover:bg-white/10' : 'text-muted hover:bg-surface2'}`}>
          Sistema
        </button>
      ) : null}
    </div>
  );
}
