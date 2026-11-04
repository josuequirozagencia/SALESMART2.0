import type { SVGAttributes } from 'react';

/**
 * Íconos de la aplicación (ADR-60): un solo componente con SVG en línea (24×24, trazo 1,75, `currentColor`) y solo los que se usan; no hay librería de íconos.
 * Se amplía aquí, no en cada pantalla. Son decorativos (`aria-hidden`): quien los usa pone el nombre accesible en el botón o el enlace.
 */
export const ICONS = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2 M5.5 5h13l3.5 7v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6z',
  calendar: 'M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4',
  dollar: 'M12 2v20 M17 6.5C16 5 14.5 4.5 12 4.5c-2.8 0-4.5 1.3-4.5 3.2 0 4.5 9.5 2 9.5 6.6 0 1.9-1.8 3.2-4.7 3.2-2.5 0-4.2-.8-5.3-2.4',
  users: 'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20 M10 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M20 20v-1.5a3.5 3.5 0 0 0-2.5-3.3 M15.5 5.2a3.5 3.5 0 0 1 0 6.6',
  team: 'M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 20v-1a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v1 M4 10a2 2 0 1 0 0-4 M20 10a2 2 0 1 0 0-4',
  building: 'M4 21V4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v17 M15 9h4a1 1 0 0 1 1 1v11 M8 8h3 M8 12h3 M8 16h3 M2 21h20',
  board: 'M3 4h5v16H3z M10 4h5v10h-5z M17 4h4v13h-4z',
  check: 'M4 12l5 5L20 6',
  chart: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',
  bot: 'M12 3v3 M5 8h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z M9 13v1 M15 13v1',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  layers: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  swap: 'M7 7h13l-3-3 M17 17H4l3 3',
  shield: 'M12 3l8 3v6c0 4.5-3.2 8.2-8 9-4.8-.8-8-4.5-8-9V6z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
  card: 'M3 6h18v12H3z M3 10h18 M7 15h3',
  form: 'M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M9 8h6 M9 12h6 M9 16h4',
  plug: 'M9 2v6 M15 2v6 M6 8h12v4a6 6 0 0 1-12 0z M12 18v4',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  close: 'M6 6l12 12 M18 6L6 18',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  logout: 'M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4 M16 17l5-5-5-5 M21 12H9',
  bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8 M10.3 21a1.9 1.9 0 0 0 3.4 0',
  chevronRight: 'M9 5l7 7-7 7',
  chevronsLeft: 'M11 17l-5-5 5-5 M18 17l-5-5 5-5',
  chevronsRight: 'M13 17l5-5-5-5 M6 17l5-5-5-5',
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20, className = 'shrink-0', ...rest }: { name: IconName; size?: number; className?: string } & Omit<SVGAttributes<SVGSVGElement>, 'name'>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...rest}>
      {ICONS[name].split(' M').map((d, i) => <path key={i} d={i === 0 ? d : `M${d}`} />)}
    </svg>
  );
}
