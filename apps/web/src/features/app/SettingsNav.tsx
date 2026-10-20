import { NavLink } from 'react-router-dom';

const tab = ({ isActive }: { isActive: boolean }): string => `-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-[13.5px] font-semibold ${isActive ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`;

/** Encabezado y pestañas de Configuración (las secciones nuevas se añaden aquí). */
export function SettingsNav() {
  return (
    <div className="grid gap-3">
      <h1 className="text-[22px] font-bold">Configuración</h1>
      <nav aria-label="Secciones de configuración" className="flex flex-wrap gap-1 border-b border-line">
        <NavLink to="/settings/fields" className={tab}>Campos personalizados</NavLink>
        <NavLink to="/settings/tags" className={tab}>Etiquetas</NavLink>
        <NavLink to="/settings/attribution" className={tab}>Atribución de Meta</NavLink>
        <NavLink to="/settings/connections" className={tab}>Conexiones</NavLink>
        <NavLink to="/settings/queues" className={tab}>Colas</NavLink>
        <NavLink to="/settings/sla" className={tab}>SLA y horario</NavLink>
        <NavLink to="/settings/quick-replies" className={tab}>Respuestas rápidas</NavLink>
      </nav>
    </div>
  );
}
