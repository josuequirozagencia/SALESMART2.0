/**
 * Aviso de que una persona aceptó una invitación a una empresa y ya es miembro (M10.3, ADR-56). La aceptación es PÚBLICA y vive en identidad; lo que la invitación pidió y es de
 * NEGOCIO (los departamentos de la persona) se aplica DESPUÉS de confirmar la aceptación, por quien se registre aquí (el módulo de equipo). Es un registro simple en memoria,
 * no un bus: el módulo de autenticación no puede depender de los de negocio. Un fallo del manejador no deshace la aceptación (queda registrado).
 */
export interface MemberJoined {
  organizationId: string;
  userId: string;
  setup: { grant: string[]; deny: string[]; queue_ids: string[] };
}
type Handler = (e: MemberJoined) => Promise<void>;

class MemberJoinedRegistry {
  private handlers: Handler[] = [];
  register(h: Handler): void {
    this.handlers.push(h);
  }
  async emit(e: MemberJoined, onError: (err: unknown) => void): Promise<void> {
    for (const h of this.handlers) {
      try {
        await h(e);
      } catch (err) {
        onError(err);
      }
    }
  }
  /** Solo pruebas. */
  clear(): void {
    this.handlers = [];
  }
}
export const memberJoined = new MemberJoinedRegistry();
