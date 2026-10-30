import { NavLink } from 'react-router-dom';

const tab = ({ isActive }: { isActive: boolean }): string => `-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-[13.5px] font-semibold ${isActive ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`;

/** Pestañas de la sección «Contactos» (M10.2, ADR-56): los contactos y, dentro de ellos, las empresas (ADR-48). «Empresas» ya no es un ítem del menú. */
export function ContactsTabs() {
  return (
    <nav aria-label="Vistas de contactos" className="flex flex-wrap gap-1 border-b border-line">
      <NavLink to="/contacts" end className={tab}>Contactos</NavLink>
      <NavLink to="/contacts/companies" className={tab}>Empresas</NavLink>
    </nav>
  );
}
