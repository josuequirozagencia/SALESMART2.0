import { Navigate, Route, Routes } from 'react-router-dom';
import { AgenciesPage } from './features/platform/AgenciesPage';
import { CompaniesPage } from './features/platform/CompaniesPage';
import { PlansPage } from './features/platform/PlansPage';
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

/** Rutas de acceso: si ya hay sesión, se va a la app. */
function Public({ children }: { children: React.ReactNode }) {
  const { state } = useSession();
  if (state.status === 'loading') return <Splash />;
  if (state.status === 'authed') return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Consola de plataforma: solo el Súper Admin; cualquier otra persona vuelve al inicio. */
function PlatformGate({ children }: { children: (me: Me, logout: () => void) => React.ReactNode }) {
  const { state, logout } = useSession();
  if (state.status === 'loading') return <Splash />;
  if (state.status === 'anon') return <Navigate to="/login" replace />;
  if (state.me.role !== 'super_admin') return <Navigate to="/" replace />;
  return <>{children(state.me, () => void logout())}</>;
}

/** Puerta de la app: sin sesión → login; Súper Admin → consola; con la prueba vencida → pantalla de «vencida»; si no → inicio. */
function AppGate() {
  const { state, logout } = useSession();
  const clientOrg = state.status === 'authed' && state.me.organization.kind === 'client';
  const trial = useTrial(clientOrg);
  if (state.status === 'loading') return <Splash />;
  if (state.status === 'anon') return <Navigate to="/login" replace />;
  if (state.me.role === 'super_admin') return <Navigate to="/platform/companies" replace />;
  if (clientOrg && trial.isPending) return <Splash />;
  const t = trial.data ?? null;
  const out = () => void logout();
  if (t?.status === 'expired') return <TrialExpiredScreen trial={t} role={state.me.role} onLogout={out} />;
  return <HomeScreen me={state.me} trial={t} onLogout={out} />;
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
      <Route path="/" element={<AppGate />} />
      <Route path="/platform/companies" element={<PlatformGate>{(me, out) => <PlatformShell me={me} onLogout={out}><CompaniesPage /></PlatformShell>}</PlatformGate>} />
      <Route path="/platform/agencies" element={<PlatformGate>{(me, out) => <PlatformShell me={me} onLogout={out}><AgenciesPage /></PlatformShell>}</PlatformGate>} />
      <Route path="/platform/plans" element={<PlatformGate>{(me, out) => <PlatformShell me={me} onLogout={out}><PlansPage /></PlatformShell>}</PlatformGate>} />
      <Route path="/platform/trials" element={<PlatformGate>{(me, out) => <PlatformShell me={me} onLogout={out}><TrialsPage /></PlatformShell>}</PlatformGate>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
