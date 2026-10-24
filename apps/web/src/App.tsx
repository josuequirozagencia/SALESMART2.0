import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AgencyShell } from './features/agency/AgencyShell';
import { ClientsPage } from './features/agency/ClientsPage';
import { AppShell } from './features/app/AppShell';
import { AnalyticsPage } from './features/analytics/AnalyticsPage';
import { AttributionPage } from './features/attribution/AttributionPage';
import { InboxPage } from './features/inbox/InboxPage';
import { AgendaPage } from './features/appointments/AgendaPage';
import { MetaPage } from './features/meta/MetaPage';
import { GhlPage } from './features/ghl/GhlPage';
import { SalesPage } from './features/sales/SalesPage';
import { ConnectionsPage } from './features/channels/ConnectionsPage';
import { QueuesPage } from './features/queues/QueuesPage';
import { QuickRepliesPage } from './features/quick-replies/QuickRepliesPage';
import { SlaPage } from './features/sla/SlaPage';
import { ContactsPage } from './features/contacts/ContactsPage';
import { ClientCompaniesPage } from './features/crm/CompaniesPage';
import { TasksPage } from './features/crm/TasksPage';
import { OpportunitiesPage } from './features/pipelines/OpportunitiesPage';
import { CustomFieldsPage } from './features/custom-fields/CustomFieldsPage';
import { TagsPage } from './features/tags/TagsPage';
import { AccessPage } from './features/platform/AccessPage';
import { AgenciesPage } from './features/platform/AgenciesPage';
import { CompaniesPage } from './features/platform/CompaniesPage';
import { PlansPage } from './features/platform/PlansPage';
import { ProvidersPage } from './features/platform/ProvidersPage';
import { PlatformShell } from './features/platform/PlatformShell';
import { TrialsPage } from './features/platform/TrialsPage';
import { TrialExpiredScreen } from './features/trial/TrialExpiredScreen';
import { useTrial } from './features/trial/useTrial';
import type { Me } from './lib/types';
import { useSession } from './lib/session';
import { ForgotScreen } from './screens/ForgotScreen';
import { HomeScreen } from './screens/HomeScreen';
import { LoginScreen } from './screens/LoginScreen';
import { AcceptInviteScreen } from './screens/AcceptInviteScreen';
import { ResetScreen } from './screens/ResetScreen';
import { SignupScreen } from './screens/SignupScreen';
import { VerifyScreen } from './screens/VerifyScreen';
import { Spinner } from './ui/controls';

function Splash() {
  return <div className="grid min-h-full place-items-center text-muted"><Spinner label="Cargando" /></div>;
}

/** Inicio de la empresa: la puerta (`AppGate`) ya garantizó que hay sesión de una empresa cliente. */
function Home() {
  const { state } = useSession();
  return state.status === 'authed' ? <HomeScreen me={state.me} /> : null;
}

/** Rutas de acceso: si ya hay sesión, se va a la app. */
function Public({ children }: { children: React.ReactNode }) {
  const { state } = useSession();
  if (state.status === 'loading') return <Splash />;
  if (state.status === 'authed') return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Consola de plataforma: solo el Súper Admin EN la plataforma (dentro de una empresa, en soporte, no es la consola); cualquier otra persona vuelve al inicio. */
function PlatformGate({ children }: { children: (me: Me, logout: () => void) => React.ReactNode }) {
  const { state, logout } = useSession();
  if (state.status === 'loading') return <Splash />;
  if (state.status === 'anon') return <Navigate to="/login" replace />;
  if (state.me.role !== 'super_admin' || state.me.organization.kind !== 'platform') return <Navigate to="/" replace />;
  return <>{children(state.me, () => void logout())}</>;
}

/** «Mis clientes»: la organización activa es una agencia (la propia, o la que el Súper Admin visita en soporte). */
function AgencyGate({ children }: { children: (me: Me, logout: () => void) => React.ReactNode }) {
  const { state, logout } = useSession();
  if (state.status === 'loading') return <Splash />;
  if (state.status === 'anon') return <Navigate to="/login" replace />;
  if (state.me.organization.kind !== 'agency') return <Navigate to="/" replace />;
  return <>{children(state.me, () => void logout())}</>;
}

/**
 * Puerta y marco de la empresa cliente: sin sesión → login; Súper Admin → consola; agencia → «Mis clientes»; con la prueba vencida → pantalla de
 * «vencida»; si no, el marco (`AppShell`) con la sección elegida (inicio, contactos…).
 */
function AppGate() {
  const { state, logout } = useSession();
  const clientOrg = state.status === 'authed' && state.me.organization.kind === 'client';
  const trial = useTrial(clientOrg);
  if (state.status === 'loading') return <Splash />;
  if (state.status === 'anon') return <Navigate to="/login" replace />;
  if (state.me.role === 'super_admin' && state.me.organization.kind === 'platform') return <Navigate to="/platform/companies" replace />;
  if (state.me.organization.kind === 'agency') return <Navigate to="/agency/clients" replace />;
  if (clientOrg && trial.isPending) return <Splash />;
  const t = trial.data ?? null;
  const out = () => void logout();
  // La pantalla de «vencida» es del propio cliente; una agencia o el Súper Admin que entra ve la empresa en SOLO LECTURA (con su banner)
  if (t?.status === 'expired' && !state.me.acting_as) return <TrialExpiredScreen trial={t} role={state.me.role} onLogout={out} />;
  return <AppShell me={state.me} trial={t} onLogout={out}><Outlet /></AppShell>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Public><LoginScreen /></Public>} />
      <Route path="/signup" element={<Public><SignupScreen /></Public>} />
      <Route path="/verify" element={<Public><VerifyScreen /></Public>} />
      <Route path="/forgot" element={<Public><ForgotScreen /></Public>} />
      {/* El enlace del correo se abre con o sin sesión: restablecer no depende de estar autenticado */}
      <Route path="/reset-password" element={<ResetScreen />} />
      <Route path="/accept-invite" element={<AcceptInviteScreen />} />
      <Route element={<AppGate />}>
        <Route path="/" element={<Home />} />
        <Route path="/inbox/:id?" element={<InboxPage />} />
        <Route path="/agenda" element={<AgendaPage />} />
        <Route path="/sales" element={<SalesPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/companies" element={<ClientCompaniesPage />} />
        <Route path="/opportunities" element={<OpportunitiesPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/settings/fields" element={<CustomFieldsPage />} />
        <Route path="/settings/tags" element={<TagsPage />} />
        <Route path="/settings/attribution" element={<AttributionPage />} />
        <Route path="/settings/meta" element={<MetaPage />} />
        <Route path="/settings/ghl" element={<GhlPage />} />
        <Route path="/settings/connections" element={<ConnectionsPage />} />
        <Route path="/settings/queues" element={<QueuesPage />} />
        <Route path="/settings/sla" element={<SlaPage />} />
        <Route path="/settings/quick-replies" element={<QuickRepliesPage />} />
      </Route>
      <Route path="/platform/companies" element={<PlatformGate>{(me, out) => <PlatformShell me={me} onLogout={out}><CompaniesPage /></PlatformShell>}</PlatformGate>} />
      <Route path="/platform/agencies" element={<PlatformGate>{(me, out) => <PlatformShell me={me} onLogout={out}><AgenciesPage /></PlatformShell>}</PlatformGate>} />
      <Route path="/platform/access" element={<PlatformGate>{(me, out) => <PlatformShell me={me} onLogout={out}><AccessPage /></PlatformShell>}</PlatformGate>} />
      <Route path="/agency/clients" element={<AgencyGate>{(me, out) => <AgencyShell me={me} onLogout={out}><ClientsPage /></AgencyShell>}</AgencyGate>} />
      <Route path="/platform/providers" element={<PlatformGate>{(me, out) => <PlatformShell me={me} onLogout={out}><ProvidersPage /></PlatformShell>}</PlatformGate>} />
      <Route path="/platform/plans" element={<PlatformGate>{(me, out) => <PlatformShell me={me} onLogout={out}><PlansPage /></PlatformShell>}</PlatformGate>} />
      <Route path="/platform/trials" element={<PlatformGate>{(me, out) => <PlatformShell me={me} onLogout={out}><TrialsPage /></PlatformShell>}</PlatformGate>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
