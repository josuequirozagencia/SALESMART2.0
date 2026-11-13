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
  reset: 'M3 12a9 9 0 1 0 3-6.7 M3 4v5h5',
  filter: 'M3 5h18 M6 12h12 M10 19h4',
  back: 'M15 5l-7 7 7 7',
  more: 'M12 5h.01 M12 12h.01 M12 19h.01',
  plus: 'M12 5v14 M5 12h14',
  pen: 'M4 20h4L19 9l-4-4L4 16z M14 6l4 4',
  camera: 'M3 8a1 1 0 0 1 1-1h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  image: 'M3 4h18v16H3z M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M21 16l-5-5-8 8',
  arrowDown: 'M12 5v14 M5 12l7 7 7-7',
  send: 'M22 2L11 13 M22 2l-7 20-4-9-9-4z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  list: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  phone: 'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z M11 18h2',
  call: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  tag: 'M3 3h8l10 10-8 8L3 11z M7.5 7.5h.01',
  note: 'M6 3h9l4 4v14H6z M14 3v5h5 M9 13h7 M9 17h7',
  task: 'M4 4h16v16H4z M8 12l3 3 5-6',
  reply: 'M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 6 6v3',
  pin: 'M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6',
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
