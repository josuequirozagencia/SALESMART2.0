/**
 * Aviso de que una empresa CLIENTE ya tiene a su primer administrador activo (M10.6, ADR-56 B5): al verificar el correo de un registro propio (ADR-23) o al aceptar la invitación del
 * dueño (ADR-39). Es el momento de crearle los datos de ejemplo. Ambas cosas viven en identidad y los datos de ejemplo son de NEGOCIO (otro rol y otra transacción, ADR-25): por eso
 * se crean DESPUÉS de confirmar el alta, por quien se registre aquí (el módulo \`sample-data\`). Es un registro simple en memoria, no un bus: el módulo de autenticación no puede
 * depender de los de negocio. Un fallo del manejador no deshace el alta (queda registrado y se reintenta en el siguiente acceso del administrador).
 */
export interface OrgReady {
  organizationId: string;
  ownerUserId: string;
}
type Handler = (e: OrgReady) => Promise<void>;

class OrgReadyRegistry {
  private handlers: Handler[] = [];
  register(h: Handler): void {
    this.handlers.push(h);
  }
  async emit(e: OrgReady, onError: (err: unknown) => void): Promise<void> {
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
export const orgReady = new OrgReadyRegistry();
