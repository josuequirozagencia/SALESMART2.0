// Aplicación Nest de PRUEBA: endpoints de fixture + resolvedor de acceso falso. Solo existe en tests.
import 'reflect-metadata';
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Module, Param, Patch, Post, Query, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { and, eq, ilike } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import { CoreModule } from '../../src/core.module';
import { Database, DbModule } from '../../src/db';
import { NotFoundError } from '../../src/errors';
import { AccessResolver, configureApp, HttpModule, PlatformOnly, Public, ZodValidationPipe, type Principal } from '../../src/http';
import { PlatformContext, TenantContext } from '../../src/tenant';
import { contacts } from '../fixtures/schema';
import { TEST_AUTH_KEY } from './constants';

/** Resolvedor de PRUEBA: confía en una cabecera. En producción esto sería inaceptable (P5); aquí simula M1. */
@Injectable()
export class HeaderAccessResolver extends AccessResolver {
  resolve(req: Request): Promise<Principal | null> {
    const h = req.header('x-test-principal');
    if (!h) return Promise.resolve(null);
    const [kind, a, b] = h.split(':');
    if (kind === 'tenant' && a && b) return Promise.resolve({ kind: 'tenant', organizationId: a, userId: b });
    if (kind === 'platform' && a) return Promise.resolve({ kind: 'platform', userId: a });
    return Promise.resolve(null);
  }
}

const createSchema = z.object({ name: z.string().min(1).max(100) }).strict();

@Controller('contacts')
class ContactsController {
  constructor(@Inject(Database) private readonly db: Database) {}

  @Get()
  list(@Query('search') search?: string) {
    return this.db.withTenant((tx) =>
      search ? tx.select().from(contacts).where(ilike(contacts.name, `%${search}%`)) : tx.select().from(contacts),
    );
  }

  @Get(':id')
  async one(@Param('id') id: string) {
    const [row] = await this.db.withTenant((tx) => tx.select().from(contacts).where(eq(contacts.id, id)));
    if (!row) throw new NotFoundError();
    return row;
  }

  @Post()
  @HttpCode(201)
  async create(@Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>) {
    const [row] = await this.db.withTenant((tx) => tx.insert(contacts).values({ name: body.name }).returning());
    return row;
  }

  @Patch(':id')
  async rename(@Param('id') id: string, @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>) {
    const [row] = await this.db.withTenant((tx) => tx.update(contacts).set({ name: body.name }).where(eq(contacts.id, id)).returning());
    if (!row) throw new NotFoundError();
    return row;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string) {
    const rows = await this.db.withTenant((tx) => tx.delete(contacts).where(and(eq(contacts.id, id))).returning());
    if (rows.length === 0) throw new NotFoundError();
  }
}

@Controller('probe')
class ProbeController {
  @Public() @Get('public') pub() { return { ok: true }; }
  @Get('whoami') whoami() { const c = TenantContext.current(); return { org: c.organizationId, user: c.userId, requestId: c.requestId }; }
  @Get('implicit-tenant') implicit() { return { ok: true }; } // sin decorador: debe ser de tenant (denegar por defecto)
  @PlatformOnly() @Get('platform') plat() { return { actor: PlatformContext.current().actorUserId }; }
  @Public() @Get('boom') boom(): never { throw new Error('fallo interno con ana.perez@correo.com y tel 0991234567'); }
  @Public() @Get('slow-json') @HttpCode(200) j() { return { a: 1 }; }
}

@Module({ controllers: [ContactsController, ProbeController] })
class FixtureRoutesModule {}

@Module({ imports: [CoreModule, DbModule, HttpModule.forRoot({ accessResolver: HeaderAccessResolver }), FixtureRoutesModule] })
export class FixtureAppModule {}

export const principalHeader = (org: string, user: string) => ({ 'x-test-principal': `tenant:${org}:${user}` });
export const platformHeader = (user: string) => ({ 'x-test-principal': `platform:${user}` });

export async function startFixtureApp(env: { rwUrl: string; platformUrl: string; identityUrl: string }): Promise<{ app: INestApplication; base: string; restore(): void }> {
  const saved = { ...process.env };
  process.env['NODE_ENV'] = 'test';
  process.env['LOG_LEVEL'] = 'silent';
  process.env['DATABASE_URL_APP'] = env.rwUrl;
  process.env['DATABASE_URL_PLATFORM'] = env.platformUrl;
  process.env['DATABASE_URL_IDENTITY'] = env.identityUrl;
  process.env['AUTH_THROTTLE_KEY'] = TEST_AUTH_KEY;
  delete process.env['DATABASE_URL_OWNER'];
  const app = await NestFactory.create(FixtureAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  return { app, base: `${await app.getUrl()}/v1`, restore: () => { process.env = saved; } };
}
