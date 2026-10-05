import 'reflect-metadata';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { ACCESS_KEY, API_PREFIX, UNVERSIONED_ROUTES, type AccessKind } from '../../src/http';
import { PERMISSION_KEY } from '../../src/rbac';

export interface DiscoveredRoute { route: string; access: AccessKind; permissions: string[] }

/** Rutas reales registradas en Nest (no análisis de texto) con su clasificación de acceso. */
export function discoverRoutes(app: INestApplication): DiscoveredRoute[] {
  const modules = app.get(ModulesContainer, { strict: false });
  const reflector = app.get(Reflector, { strict: false });
  const out: DiscoveredRoute[] = [];
  const controllers = [...modules.values()].flatMap((m) => [...m.controllers.values()]);
  for (const w of controllers) {
    const cls = w.metatype as (new () => unknown) | null;
    if (!cls) continue;
    const base = (Reflect.getMetadata('path', cls) as string | undefined) ?? '';
    for (const name of Object.getOwnPropertyNames(cls.prototype)) {
      const handler = (cls.prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function' || name === 'constructor') continue;
      const method = Reflect.getMetadata('method', handler) as number | undefined;
      if (method === undefined) continue;
      const path = (Reflect.getMetadata('path', handler) as string | undefined) ?? '';
      const access = reflector.getAllAndOverride<AccessKind | undefined>(ACCESS_KEY, [handler as never, cls]) ?? 'tenant';
      const local = `/${[base, path === '/' ? '' : path].filter(Boolean).join('/')}`.replace(/\/+/g, '/');
      // Misma regla que configureApp (prefijo global /v1 salvo sondeos de salud)
      const full = UNVERSIONED_ROUTES.includes(local.replace(/^\//, '')) ? local : `/${API_PREFIX}${local}`;
      const permissions = reflector.getAllAndOverride<string[] | undefined>(PERMISSION_KEY, [handler as never, cls]) ?? [];
      out.push({ route: `${RequestMethod[method]} ${full}`, access, permissions });
    }
  }
  return out.sort((a, b) => a.route.localeCompare(b.route));
}
