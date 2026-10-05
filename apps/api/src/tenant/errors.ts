/** Se intentó acceder a datos de negocio sin un TenantContext activo. */
export class MissingTenantContextError extends Error {
  constructor(what = 'acceso a datos de negocio') {
    super(`${what} sin TenantContext activo (ADR-24: el contexto de organización es obligatorio)`);
    this.name = 'MissingTenantContextError';
  }
}

/** Contexto inválido (UUID mal formado, anidamiento, mezcla tenant/plataforma). */
export class InvalidContextError extends Error {
  constructor(reason: string) {
    super(`Contexto inválido: ${reason}`);
    this.name = 'InvalidContextError';
  }
}

export class MissingPlatformContextError extends Error {
  constructor() {
    super('acceso de plataforma sin PlatformContext activo');
    this.name = 'MissingPlatformContextError';
  }
}
