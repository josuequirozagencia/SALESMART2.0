import type { AccessLevel } from '../../rbac';
import type { ActingAs, AuthContext } from './session.service';

type OrgKind = 'platform' | 'agency' | 'client';

/**
 * Quién soy y en qué contexto estoy (`/auth/me`, login y cambio de contexto). La web NO decide nada con esto: solo lo pinta
 * (banner «Administrando X», solo lectura); el servidor vuelve a verificar todo en cada petición (ADR-41).
 */
export interface MeView {
  user: { id: string; email: string; full_name: string | null };
  organization: { id: string; name: string; kind: string };
  role: string;
  /** Organización con la que empezó la sesión («Volver a mi agencia»). */
  home: { id: string; name: string; kind: string };
  acting_as: ActingAs | null;
  read_only: boolean;
  access_level: AccessLevel | null;
}

export function toMeView(c: AuthContext): MeView {
  return {
    user: { id: c.userId, email: c.user.email, full_name: c.user.fullName },
    organization: { id: c.organizationId, name: c.orgName, kind: c.orgKind },
    role: c.role,
    home: { ...c.home },
    acting_as: c.actingAs,
    read_only: c.readOnly,
    access_level: c.accessLevel,
  };
}

/** Vista de una sesión recién creada: nace en su organización de origen y no actúa en ninguna otra. */
export function homeView(u: { id: string; email: string; fullName: string | null }, org: { id: string; name: string; kind: OrgKind | string }, role: string): MeView {
  return { user: { id: u.id, email: u.email, full_name: u.fullName }, organization: { ...org }, role, home: { ...org }, acting_as: null, read_only: false, access_level: null };
}
