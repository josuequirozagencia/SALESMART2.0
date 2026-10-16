# Plan M3.3 — Etiquetas del sistema + Atribución Meta + CAPI Purchase

**Estado:** pendiente (M3.2 en curso)  
**Fecha de elaboración:** 2026-10-16  
**ADRs que aplican:** ADR-08, ADR-18, ADR-43 (ya aprobados); ADR nuevo para atribución (ver §5)

---

## Qué se construye en M3.3

M3.3 tiene dos entregables que se despliegan juntos porque comparten la misma migración y el mismo flujo de datos:

1. **Etiquetas del sistema** — `Lead`, `Cita agendada`, `Venta` (no borrables, solo el sistema las pone, ADR-08)
2. **Atribución de Meta Ads** — captura first-touch / last-touch en el contacto al entrar por CTWA (Click to WhatsApp)
3. **Evento Purchase a Meta CAPI** — job diferido cancelable que se dispara cuando el sistema pone la etiqueta `Venta`

---

## 1. Migración `0027_m33_tags_attribution.sql`

### 1.1 Tabla `tags`

```sql
CREATE TABLE "tags" (
  "organization_id" uuid DEFAULT app_org() NOT NULL,
  "id"              uuid PRIMARY KEY NOT NULL,
  "name"            text NOT NULL,
  "color"           text NOT NULL DEFAULT '#6a44f2',
  "is_system"       boolean NOT NULL DEFAULT false,
  "system_key"      text,          -- 'lead' | 'appointment' | 'sale' | null
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "deleted_at"      timestamptz,   -- NULL para etiquetas del sistema (inborrables por lógica de app)
  CONSTRAINT "tags_org_id_uq"      UNIQUE("organization_id","id"),
  CONSTRAINT "tags_system_key_ck"  CHECK("system_key" IS NULL OR "system_key" IN ('lead','appointment','sale')),
  CONSTRAINT "tags_name_shape"     CHECK(length(btrim("name")) BETWEEN 1 AND 60)
);
ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tags" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tags_tenant_isolation" ON "tags"
  AS PERMISSIVE FOR ALL TO public
  USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());

-- Índice único para system_key dentro de una organización (máx 1 "sale" por org)
CREATE UNIQUE INDEX "tags_org_system_key_uq"
  ON "tags"("organization_id","system_key")
  WHERE "system_key" IS NOT NULL AND "deleted_at" IS NULL;
```

### 1.2 Tabla `contact_tags` (pivote)

```sql
CREATE TABLE "contact_tags" (
  "organization_id" uuid DEFAULT app_org() NOT NULL,
  "contact_id"      uuid NOT NULL,
  "tag_id"          uuid NOT NULL,
  "set_by"          text NOT NULL DEFAULT 'user',   -- 'user' | 'system'
  "set_at"          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id","contact_id","tag_id"),
  CONSTRAINT "contact_tags_contact_fk" FOREIGN KEY ("organization_id","contact_id")
    REFERENCES "contacts"("organization_id","id"),
  CONSTRAINT "contact_tags_tag_fk" FOREIGN KEY ("organization_id","tag_id")
    REFERENCES "tags"("organization_id","id")
);
ALTER TABLE "contact_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_tags" FORCE ROW LEVEL SECURITY;
CREATE POLICY "contact_tags_tenant_isolation" ON "contact_tags"
  AS PERMISSIVE FOR ALL TO public
  USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
CREATE INDEX "contact_tags_contact_idx" ON "contact_tags"("organization_id","contact_id");
```

### 1.3 Columnas de atribución en `contacts`

```sql
ALTER TABLE "contacts"
  ADD COLUMN "ctwa_cl_id"          text,
  ADD COLUMN "first_touch_at"      timestamptz,
  ADD COLUMN "first_touch_source"  text,   -- 'meta_ctwa' | 'organic' | etc.
  ADD COLUMN "first_touch_campaign" text,
  ADD COLUMN "first_touch_adset"   text,
  ADD COLUMN "first_touch_ad"      text,
  ADD COLUMN "last_touch_at"       timestamptz,
  ADD COLUMN "last_touch_source"   text,
  ADD COLUMN "last_touch_campaign" text,
  ADD COLUMN "last_touch_adset"    text,
  ADD COLUMN "last_touch_ad"       text;

-- CHECK: si hay ctwa_cl_id debe ser string no vacío
ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_ctwa_cl_id_shape"
  CHECK("ctwa_cl_id" IS NULL OR length(btrim("ctwa_cl_id")) > 0);
```

### 1.4 Tabla `meta_capi_events` (outbox)

```sql
CREATE TABLE "meta_capi_events" (
  "organization_id" uuid DEFAULT app_org() NOT NULL,
  "id"              uuid PRIMARY KEY NOT NULL,
  "event_name"      text NOT NULL,  -- 'Lead' | 'Schedule' | 'Purchase' | 'SaleCanceled'
  "event_time"      timestamptz NOT NULL,
  "event_id"        text NOT NULL,  -- estable, idempotencia en Meta
  "contact_id"      uuid,
  "payload"         jsonb NOT NULL,
  "status"          text NOT NULL DEFAULT 'pending',  -- 'pending' | 'sent' | 'cancelled' | 'failed'
  "scheduled_for"   timestamptz,   -- para el job diferido con ventana de gracia
  "sent_at"         timestamptz,
  "error"           text,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "meta_capi_events_org_id_uq"    UNIQUE("organization_id","id"),
  CONSTRAINT "meta_capi_events_event_id_uq"  UNIQUE("organization_id","event_id"),
  CONSTRAINT "meta_capi_events_status_ck"    CHECK("status" IN ('pending','sent','cancelled','failed')),
  CONSTRAINT "meta_capi_events_name_ck"      CHECK("event_name" IN ('Lead','Schedule','Purchase','SaleCanceled'))
);
ALTER TABLE "meta_capi_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meta_capi_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meta_capi_events_tenant_isolation" ON "meta_capi_events"
  AS PERMISSIVE FOR ALL TO public
  USING (organization_id = app_org()) WITH CHECK (organization_id = app_org());
CREATE INDEX "meta_capi_events_pending_idx" ON "meta_capi_events"("scheduled_for")
  WHERE "status" = 'pending';
```

---

## 2. Schema Drizzle — `apps/api/src/db/schema/crm.ts`

Agregar a `crm.ts` (después de `contactPhones`):

```typescript
// ── Atribución Meta (first / last touch) ─────────────────────────────────
// Campos ya en la tabla contacts via ALTER; solo agregar al objeto Drizzle:
// ctwaClId, firstTouchAt, firstTouchSource, firstTouchCampaign, firstTouchAdset, firstTouchAd
// lastTouchAt, lastTouchSource, lastTouchCampaign, lastTouchAdset, lastTouchAd

export const tags = tenantTable('tags', {
  id:        uuid('id').primaryKey().$defaultFn(uuidv7),
  name:      text('name').notNull(),
  color:     text('color').notNull().default('#6a44f2'),
  isSystem:  boolean('is_system').notNull().default(false),
  systemKey: text('system_key'),   // 'lead' | 'appointment' | 'sale'
  createdAt: ts('created_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
}, (t) => [
  check('tags_system_key_ck', sql`${t.systemKey} IS NULL OR ${t.systemKey} IN ('lead','appointment','sale')`),
  check('tags_name_shape', sql`length(btrim(${t.name})) BETWEEN 1 AND 60`),
  uniqueIndex('tags_org_system_key_uq').on(t.organizationId!, t.systemKey!).where(sql`${t.systemKey} IS NOT NULL AND ${t.deletedAt} IS NULL`),
]);

export const contactTags = tenantTable('contact_tags', {
  contactId: uuid('contact_id').notNull(),
  tagId:     uuid('tag_id').notNull(),
  setBy:     text('set_by').notNull().default('user'),   // 'user' | 'system'
  setAt:     ts('set_at').notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'contact_tags_contact_fk', columns: [t.organizationId!, t.contactId], foreignColumns: [contacts.organizationId, contacts.id] }),
  foreignKey({ name: 'contact_tags_tag_fk',     columns: [t.organizationId!, t.tagId],     foreignColumns: [tags.organizationId, tags.id] }),
  index('contact_tags_contact_idx').on(t.organizationId!, t.contactId),
]);

export const metaCapiEvents = tenantTable('meta_capi_events', {
  id:           uuid('id').primaryKey().$defaultFn(uuidv7),
  eventName:    text('event_name').notNull(),
  eventTime:    ts('event_time').notNull(),
  eventId:      text('event_id').notNull(),
  contactId:    uuid('contact_id'),
  payload:      jsonb('payload').notNull(),
  status:       text('status').notNull().default('pending'),
  scheduledFor: ts('scheduled_for'),
  sentAt:       ts('sent_at'),
  error:        text('error'),
  createdAt:    ts('created_at').notNull().defaultNow(),
}, (t) => [
  check('meta_capi_events_status_ck',  sql`${t.status} IN ('pending','sent','cancelled','failed')`),
  check('meta_capi_events_name_ck',    sql`${t.eventName} IN ('Lead','Schedule','Purchase','SaleCanceled')`),
  uniqueIndex('meta_capi_events_event_id_uq').on(t.organizationId!, t.eventId),
  index('meta_capi_events_pending_idx').on(t.scheduledFor!).where(sql`${t.status} = 'pending'`),
]);
```

---

## 3. Módulo `attribution` — `apps/api/src/modules/attribution/`

### 3.1 Estructura de archivos

```
modules/attribution/
  index.ts                     ← API pública del módulo
  attribution.module.ts
  attribution.service.ts       ← lógica: recibir datos CTWA, grabar first/last touch
  capi.service.ts              ← enviar eventos a Meta CAPI (puerto)
  capi.fake.ts                 ← fake para tests
  capi.ports.ts                ← interfaz ICapiProvider
  purchase-sender.job.ts       ← job diferido PostgreSQL SKIP LOCKED (ventana de gracia)
  attribution.dto.ts           ← Zod schemas
```

### 3.2 `AttributionService` — reglas de negocio

```typescript
// Cuando llega un contacto desde CTWA (webhook de Meta/GHL):
async recordAttribution(contactId: string, orgId: string, data: CtwaPayload) {
  // 1. Si first_touch_at IS NULL → graba first touch (NUNCA sobreescribir)
  // 2. Siempre sobreescribe last touch
  // 3. Inserta evento Lead en meta_capi_events (status='pending', scheduled_for=now())
  //    — el Lead se envía de inmediato (sin ventana de gracia)
}

// Cuando el sistema pone la etiqueta "Venta":
async onSaleTagSet(contactId: string, orgId: string, saleId: string, amount: number) {
  // 1. Calcular scheduled_for = now() + grace_period (default 30 min, config por org)
  // 2. Insertar fila en meta_capi_events (status='pending', scheduled_for=...)
  // 3. El job purchase-sender.job.ts la recoge cuando llega la hora
}

// Cuando se cancela la venta (dentro de la ventana):
async cancelPurchaseEvent(saleId: string, orgId: string) {
  // UPDATE meta_capi_events SET status='cancelled' WHERE event_id=... AND status='pending'
}
```

### 3.3 `purchase-sender.job.ts` (PostgreSQL SKIP LOCKED, sin BullMQ)

Igual al patrón ya usado en M1.5 (`scheduled-job.ts`):

```typescript
// SELECT ... FROM meta_capi_events
//   WHERE status = 'pending' AND scheduled_for <= now()
//   FOR UPDATE SKIP LOCKED
//   LIMIT 10
// → para cada fila: llamar ICapiProvider.sendEvent(), UPDATE status='sent'/'failed'
```

### 3.4 `ICapiProvider` (puerto)

```typescript
interface ICapiProvider {
  sendEvent(payload: CapiEventPayload): Promise<void>;
}

// Implementación real: POST https://graph.facebook.com/v19.0/{pixel_id}/events
// con access_token del dataset de la organización (cifrado en provider_credentials)

// Fake para tests: guarda en array, expone last()
```

---

## 4. Webhook de entrada — `POST /v1/attribution/ctwa`

**Quién llama a este endpoint:**
- GHL Workflow (cuando un contacto entra por CTWA) — pasa `ctwaClId`, `campaign_name`, `adset_name`, `ad_name`, `phone`
- Alternativa futura: webhook directo de Meta Cloud API

**Seguridad:**
- Autenticación por `X-Webhook-Secret` (HMAC, igual que los demás webhooks del sistema)
- Rate limit estricto
- Validación Zod

**Payload esperado:**
```typescript
const CtwaWebhookSchema = z.object({
  phone:         z.string(),          // E.164 del contacto
  ctwa_cl_id:    z.string(),
  campaign_name: z.string().optional(),
  adset_name:    z.string().optional(),
  ad_name:       z.string().optional(),
  source:        z.string().default('meta_ctwa'),
  occurred_at:   z.string().datetime().optional(),
});
```

**Flujo:**
1. Buscar contacto por teléfono E.164 en la organización (RLS)
2. Si no existe → crear contacto con `source='meta_ctwa'`
3. Llamar `AttributionService.recordAttribution()`
4. Responder `{ ok: true }` (idempotente — misma llamada dos veces no duplica)

---

## 5. Nuevo ADR requerido: ADR-44 (Atribución Meta Ads)

Antes de empezar M3.3, Code debe proponer **ADR-44** con:

- **Decisión:** campos first/last touch en `contacts`, sin tabla separada de touch events por ahora
- **Alternativa descartada:** tabla `contact_touch_events` (complejidad sin retorno en M3)
- **Extensibilidad:** tabla `contact_touch_events` se puede agregar en M4/M5 sin romper nada
- **Proveedor CAPI:** pixel/dataset configurado por organización, credenciales cifradas en `provider_credentials` (ADR-42)
- **Ventana de gracia del Purchase:** configurable por org (default 30 min, máx 24 h), job propio sobre PG (sin BullMQ hasta M6)
- **first_touch:** nunca se sobreescribe una vez grabado
- **last_touch:** se sobreescribe en cada nuevo clic CTWA
- **ctwa_cl_id:** del último clic (el que se envía a CAPI como `click_id`)

---

## 6. UI — `ContactDialog.tsx`

Agregar sección **"Origen del lead"** al final del formulario, solo cuando `contact.ctwaClId` o `contact.firstTouchAt` existan. Es **100% read-only** — ningún campo es editable.

**Referencia visual:** ver el prototipo publicado en:  
`https://claude.ai/artifact/MmnyqCVTvjaw9fwnF1mF9f`

**Datos a mostrar:**
| Campo UI | Campo BD |
|---|---|
| Campaña | `last_touch_campaign` |
| Conjunto de anuncios | `last_touch_adset` |
| Anuncio | `last_touch_ad` (con enlace a Meta Ads Manager si hay `ctwa_cl_id`) |
| Canal de entrada | badge "Click to WhatsApp" si `source = 'meta_ctwa'` |
| CTWA Click ID | `ctwa_cl_id` (truncado, con botón copiar) |
| Primer clic | `first_touch_at` + `first_touch_campaign` |
| Último clic | `last_touch_at` + `last_touch_campaign` |
| Estado CAPI | último `meta_capi_events` del contacto con `event_name='Purchase'` |

La sección es colapsable (chevron). Colapsar/expandir no llama al servidor.

**Endpoint nuevo para la UI:**  
`GET /v1/contacts/:id/attribution` → devuelve los campos de atribución + estado del último evento CAPI.  
(O incluirlos directamente en `GET /v1/contacts/:id` si Code lo prefiere, para no añadir un round-trip.)

---

## 7. Tipos compartidos — `packages/shared`

Agregar a los tipos Zod compartidos:

```typescript
export const ContactAttributionSchema = z.object({
  ctwaClId:           z.string().nullable(),
  firstTouchAt:       z.string().datetime().nullable(),
  firstTouchSource:   z.string().nullable(),
  firstTouchCampaign: z.string().nullable(),
  firstTouchAdset:    z.string().nullable(),
  firstTouchAd:       z.string().nullable(),
  lastTouchAt:        z.string().datetime().nullable(),
  lastTouchSource:    z.string().nullable(),
  lastTouchCampaign:  z.string().nullable(),
  lastTouchAdset:     z.string().nullable(),
  lastTouchAd:        z.string().nullable(),
  capiStatus:         z.enum(['pending','sent','cancelled','failed','none']).nullable(),
  capiSentAt:         z.string().datetime().nullable(),
});
```

---

## 8. Tests obligatorios

- **Aislamiento A↔B:** dos orgs, el webhook de la org A no graba atribución en org B
- **First-touch inmutable:** llamar `recordAttribution` dos veces → `first_touch_at` no cambia, `last_touch_at` sí
- **Ventana de gracia:** crear venta → status=`pending`; cancelar dentro de la ventana → status=`cancelled`; esperar la ventana → job envía el evento
- **Idempotencia del webhook:** mismo `ctwa_cl_id` dos veces → solo una fila en `meta_capi_events`
- **Fake CAPI:** el fake captura el payload y permite asertar que se envió con los valores correctos

---

## 9. Criterio de aceptación de M3.3

- [ ] Migración `0027` aplica sin error; `pnpm db:audit` pasa
- [ ] ADR-44 propuesto y aprobado por Josué antes de empezar el código
- [ ] El webhook `/v1/attribution/ctwa` graba first/last touch correctamente
- [ ] La etiqueta `Venta` dispara el job con ventana de gracia; cancelar dentro de la ventana evita el envío a Meta
- [ ] `ContactDialog` muestra la sección "Origen del lead" (solo si hay datos) con el diseño del prototipo
- [ ] Tests de aislamiento, first-touch inmutable, ventana de gracia e idempotencia: todos verdes
- [ ] `pnpm check` verde (typecheck + lint + test)

---

## 10. Orden de implementación sugerido

1. Proponer ADR-44 → esperar aprobación de Josué
2. Migración `0027` (tablas + columnas)
3. Schema Drizzle (`crm.ts` actualizado)
4. `AttributionService` + tests
5. `ICapiProvider` + fake + contract test
6. Webhook `/v1/attribution/ctwa` + tests de aislamiento
7. `purchase-sender.job.ts` + tests de ventana de gracia
8. API `GET /v1/contacts/:id` — incluir `attribution` en la respuesta
9. UI — sección "Origen del lead" en `ContactDialog`
10. `pnpm check` completo
