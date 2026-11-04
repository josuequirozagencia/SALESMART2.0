import { createContext, useContext } from 'react';
import type { Me } from '../../lib/types';
import type { NavGroup } from '../../ui/SidebarShell';

/** Lo que el marco de la empresa comparte con la barra inferior y la página `/menu`: las mismas secciones (una sola definición), la persona y cómo salir. */
export interface AppNavValue {
  me: Me;
  groups: NavGroup[];
  unread: number;
  onLogout: () => void;
}

export const AppNavContext = createContext<AppNavValue | null>(null);

export function useAppNav(): AppNavValue {
  const v = useContext(AppNavContext);
  if (!v) throw new Error('useAppNav fuera del marco de la empresa');
  return v;
}
