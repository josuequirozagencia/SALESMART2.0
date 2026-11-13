import { Dashboard } from '../features/analytics/Dashboard';
import { OnboardingCard } from '../features/onboarding/OnboardingCard';
import type { Me } from '../lib/types';
import { PAGE_TITLE } from '../ui/PageHeader';

/**
 * Inicio de una empresa cliente: el saludo y el tablero del periodo (M6.5). El marco (cabecera, banners, secciones) lo pone `AppShell`.
 */
export function HomeScreen({ me }: { me: Me }) {
  return (
    <div className="grid gap-5">
      <h1 className={PAGE_TITLE}>Hola, {me.organization.name}</h1>
      <OnboardingCard me={me} />
      <Dashboard />
    </div>
  );
}
