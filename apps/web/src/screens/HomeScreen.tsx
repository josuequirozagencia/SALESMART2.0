import { Dashboard } from '../features/analytics/Dashboard';
import type { Me } from '../lib/types';

/**
 * Inicio de una empresa cliente: el saludo y el tablero del periodo (M6.5). El marco (cabecera, banners, secciones) lo pone `AppShell`.
 */
export function HomeScreen({ me }: { me: Me }) {
  return (
    <div className="grid gap-5">
      <h1 className="text-[22px] font-bold">Hola, {me.organization.name}</h1>
      <Dashboard />
    </div>
  );
}
