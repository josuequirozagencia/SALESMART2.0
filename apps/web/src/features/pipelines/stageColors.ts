import type { CSSProperties } from 'react';
import type { StageColor } from '../../lib/types';

/** Paleta de 8 pasteles de las etapas (ADR-49): las mismas claves que valida el servidor. */
export const STAGE_COLORS: ReadonlyArray<{ key: StageColor; label: string; hex: string }> = [
  { key: 'blue', label: 'Azul', hex: '#CFE2FB' },
  { key: 'teal', label: 'Turquesa', hex: '#C8EBEA' },
  { key: 'violet', label: 'Violeta', hex: '#DAD4F8' },
  { key: 'amber', label: 'Ámbar', hex: '#FBE6B8' },
  { key: 'green', label: 'Verde', hex: '#CDEBD8' },
  { key: 'red', label: 'Rojo', hex: '#F6CFCF' },
  { key: 'pink', label: 'Rosa', hex: '#F6D2E6' },
  { key: 'gray', label: 'Gris', hex: '#DFE3EA' },
];

const HEX = Object.fromEntries(STAGE_COLORS.map((c) => [c.key, c.hex])) as Record<StageColor, string>;

/** Relleno pastel de un encabezado de columna; en el tema oscuro se mezcla con la superficie (variable --stage-mix). */
export const stageStyle = (color: StageColor): CSSProperties => ({ backgroundColor: `color-mix(in srgb, ${HEX[color] ?? HEX.gray} var(--stage-mix, 100%), var(--surface))` });
