import { Icon } from './Icon';
import { useTheme } from './theme';

/**
 * Botón de modo claro/oscuro SOLO con icono (luna / sol), sin texto. Cambia el modo de toda la plataforma (el mismo mecanismo de `ui/theme.ts`); «Usar el del sistema» vive en
 * Configuración › Apariencia. `onDark` lo pinta para una barra oscura; `touch` le da el objetivo táctil de 44 px.
 */
export function ThemeToggle({ onDark = false, touch = false }: { onDark?: boolean; touch?: boolean }) {
  const { effective, setMode } = useTheme();
  const dark = effective === 'dark';
  const label = dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setMode(dark ? 'light' : 'dark')}
      className={`grid shrink-0 place-items-center rounded-full transition-colors ${touch ? 'size-11' : 'size-10'} ${onDark ? 'text-white/85 hover:bg-white/10' : 'text-muted hover:bg-surface2 hover:text-fg'}`}
    >
      <Icon name={dark ? 'sun' : 'moon'} size={20} />
    </button>
  );
}
