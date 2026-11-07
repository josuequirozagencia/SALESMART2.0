# Plan M3.3 — Etiquetas del sistema + Atribución Meta + CAPI Purchase

**Estado base:** implementado (ADR-45 aprobado, 2026-10-16)  
**Adiciones:** §11 Canal del lead · §12 Panel de rendimiento de anuncios — **construidas el 2026-11-07** (ver §13 «Notas de implementación»)  
**Fecha de elaboración:** 2026-10-16 — **Actualizado:** 2026-11-07  
**ADRs que aplican:** ADR-08, ADR-18, ADR-43, ADR-45

---

## Qué se construye en M3.3

M3.3 tiene dos entregables que se despliegan juntos porque comparten la misma migración y el mismo flujo de datos:

1. **Etiquetas del sistema** — `Lead`, `Cita agendada`, `Venta` (no borrables, solo el sistema las pone, ADR-08)
2. **Atribución de Meta Ads** — captura first-touch / last-touch en el contacto al entrar por CTWA (Click to WhatsApp)
3. **Evento Purchase a Meta CAPI** — job diferido cancelable que se dispara cuando el sistema pone la etiqueta `Venta`

**Adiciones aprobadas el 2026-11-07** (ver §11 y §12):
4. **Canal del lead** — campo visible `channel` (`facebook` / `instagram` / `whatsapp` / `manual`) en el contacto y en la UI
5. **Panel de rendimiento de anuncios** — pantalla de administrador con tabla de anuncios ordenada por ventas y estrella dorada ⭐ en el anuncio top

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

## 10. Orden de implementación sugerido (base, ya ejecutado)

1. ~~Proponer ADR-45 → esperar aprobación de Josué~~ ✅
2. ~~Migración `0027` (tablas + columnas)~~ ✅
3. ~~Schema Drizzle (`crm.ts` actualizado)~~ ✅
4. ~~`AttributionService` + tests~~ ✅
5. ~~`ICapiProvider` + fake + contract test~~ ✅
6. ~~Webhook `/v1/attribution/ctwa` + tests de aislamiento~~ ✅
7. ~~`purchase-sender.job.ts` + tests de ventana de gracia~~ ✅
8. ~~API `GET /v1/contacts/:id` — incluir `attribution` en la respuesta~~ ✅
9. ~~UI — sección "Origen del lead" en `ContactDialog`~~ ✅
10. ~~`pnpm check` completo~~ ✅

---

## 11. ADICIÓN — Canal del lead (`channel`)

> **Aprobado 2026-11-07.** Número de migración a usar: el siguiente disponible tras las actuales.

### 11.1 Por qué

El campo `source` (`meta_ctwa`, `manual`, etc.) es técnico. El administrador y el asesor necesitan ver el **canal de entrada** en lenguaje humano: de qué red social llegó el cliente. Esto también permite filtrar y reportar por canal.

### 11.2 Columna nueva en `contacts`

```sql
ALTER TABLE "contacts"
  ADD COLUMN "channel" text NOT NULL DEFAULT 'manual'
  CONSTRAINT "contacts_channel_ck"
    CHECK("channel" IN ('facebook','instagram','whatsapp','manual','other'));
```

**Reglas de derivación automática** (en `AttributionService.recordAttribution`):

| Condición | `channel` |
|---|---|
| `source = 'meta_ctwa'` y placement contiene `'instagram'` | `'instagram'` |
| `source = 'meta_ctwa'` y placement contiene `'facebook'` o sin placement | `'facebook'` |
| Contacto creado por WhatsApp sin CTWA | `'whatsapp'` |
| Creado manualmente desde la UI | `'manual'` |
| Cualquier otro caso | `'other'` |

El campo `channel` **solo se fija en la creación** del contacto (como `first_touch`). No se sobreescribe en clics posteriores.

Meta envía el placement en el payload CTWA como `referral.source_type` o `referral.media_type`; revisar el adaptador real cuando llegue en M6.

### 11.3 Schema Drizzle

Agregar al objeto `contacts` en `crm.ts`:

```typescript
channel: text('channel').notNull().default('manual'),
```

Con el check en la migración SQL (Drizzle no genera CHECKs con enum de texto, se pone en SQL directo).

### 11.4 Webhook — payload actualizado

Agregar campo opcional `placement` al `CtwaWebhookSchema`:

```typescript
const CtwaWebhookSchema = z.object({
  // ... campos existentes ...
  placement: z.enum(['facebook','instagram']).optional(),  // del payload de Meta/GHL
});
```

`AttributionService.recordAttribution` recibe el `placement` y aplica la regla de derivación del §11.2.

### 11.5 UI — badge de canal en "Origen del lead"

En la sección **"Origen del lead"** del `ContactDialog`, agregar un badge visual justo debajo del título:

| `channel` | Badge | Ícono sugerido |
|---|---|---|
| `facebook` | `Facebook` | ícono F azul |
| `instagram` | `Instagram` | gradiente rosa-naranja |
| `whatsapp` | `WhatsApp` | verde WhatsApp |
| `manual` | `Manual` | ícono lápiz, neutro |
| `other` | `Otro canal` | neutro |

El badge también se muestra en la **tabla de contactos** como columna opcional "Canal" (junto a las columnas configurables de M3.4).

### 11.6 Tipos compartidos — añadir `channel`

```typescript
export const ContactAttributionSchema = z.object({
  // ... campos existentes ...
  channel: z.enum(['facebook','instagram','whatsapp','manual','other']),
});
```

### 11.7 Tests adicionales

- Webhook con `placement='instagram'` → `channel='instagram'`
- Webhook con `placement='facebook'` → `channel='facebook'`
- Webhook sin `placement` → `channel='facebook'` (default Meta CTWA)
- Contacto creado manualmente → `channel='manual'`
- `channel` no cambia si llega un segundo webhook para el mismo contacto

---

## 12. ADICIÓN — Panel de rendimiento de anuncios

> **Aprobado 2026-11-07.** Solo visible para `client_admin` y superiores. Permiso requerido: `attribution.view` (nuevo).

### 12.1 Qué muestra

Pantalla **"Rendimiento de anuncios"** accesible desde el menú de Configuración (o desde una sección "Atribución" en el sidebar del administrador).

Tabla ordenada por **ventas (descendente)** con las siguientes columnas:

| Columna | Fuente |
|---|---|
| ⭐ | estrella dorada solo en el 1er row (el anuncio con más ventas) |
| Anuncio | `last_touch_ad` del contacto |
| Conjunto de anuncios | `last_touch_adset` |
| Campaña | `last_touch_campaign` |
| Canal | `channel` del contacto |
| Leads | contactos con `last_touch_ad = X` |
| Ventas | contactos con etiqueta `Venta` y `last_touch_ad = X` |
| Conv. % | Ventas / Leads × 100 |

**Filtros disponibles:**
- Rango de fechas (`first_touch_at` o `last_touch_at`, configurable)
- Canal (`facebook` / `instagram` / `whatsapp` / `manual`)
- Campaña (dropdown de campañas únicas en el periodo)

**La estrella dorada ⭐** se muestra en el anuncio con más ventas en el periodo seleccionado. Si hay empate, la estrella va al que tiene más leads.

### 12.2 Endpoint de API

```
GET /v1/attribution/ad-performance
```

**Query params:**
```typescript
z.object({
  from:    z.string().datetime().optional(),   // default: hace 30 días
  to:      z.string().datetime().optional(),   // default: hoy
  channel: z.enum(['facebook','instagram','whatsapp','manual','other']).optional(),
  touchModel: z.enum(['last','first']).default('last'),  // qué touch usar para agrupar
})
```

**Respuesta:**
```typescript
{
  rows: Array<{
    adName:       string | null,
    adsetName:    string | null,
    campaignName: string | null,
    channel:      string,
    leads:        number,
    sales:        number,
    convRate:     number,   // 0-100
    isTopAd:      boolean,  // true solo en el primero
  }>,
  period: { from: string, to: string },
  touchModel: 'last' | 'first',
}
```

**Query SQL (simplificado):**
```sql
SELECT
  last_touch_ad       AS ad_name,
  last_touch_adset    AS adset_name,
  last_touch_campaign AS campaign_name,
  channel,
  COUNT(*)                                                       AS leads,
  COUNT(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM contact_tags ct
    JOIN tags t ON t.organization_id = ct.organization_id AND t.id = ct.tag_id
    WHERE ct.contact_id = contacts.id
      AND ct.organization_id = contacts.organization_id
      AND t.system_key = 'sale'
  ))                                                             AS sales
FROM contacts
WHERE organization_id = app_org()
  AND deleted_at IS NULL
  AND last_touch_at BETWEEN :from AND :to
  AND last_touch_ad IS NOT NULL
GROUP BY last_touch_ad, last_touch_adset, last_touch_campaign, channel
ORDER BY sales DESC, leads DESC
```

**Permiso:** `attribution.view` — solo `client_admin` y superiores. Agregar a la matriz de permisos en `src/rbac/catalog.ts`.

**Test de aislamiento:** org A no ve datos de org B.

### 12.3 UI — pantalla "Rendimiento de anuncios"

**Ruta:** `/attribution` (dentro del `AppShell` de la empresa)

**Acceso:** solo visible en el sidebar para usuarios con `attribution.view`.

**Comportamiento de la estrella:**
- El primer row de la tabla lleva un ícono ⭐ dorado a la izquierda del nombre del anuncio.
- Si no hay ventas aún (todos en 0), la estrella no aparece.
- Tooltip al hacer hover: `"Anuncio con más ventas en el periodo"`.

**Comportamiento vacío:**
- Si no hay datos de atribución aún: mensaje vacío con enlace a "Configuración › Atribución de Meta" para configurar el webhook.

**Responsive:** en móvil la tabla colapsa a cards con los datos principales (anuncio, leads, ventas, conv%).

### 12.4 Criterios de aceptación de las adiciones

- [ ] Migración nueva aplica sin error; `pnpm db:audit` pasa
- [ ] Webhook con `placement='instagram'` guarda `channel='instagram'` en el contacto
- [ ] Contacto creado manualmente tiene `channel='manual'`
- [ ] `channel` no cambia en clics posteriores del mismo contacto
- [ ] Badge de canal visible en la sección "Origen del lead" del ContactDialog
- [ ] `GET /v1/attribution/ad-performance` devuelve solo datos de la org del solicitante
- [ ] El anuncio con más ventas lleva `isTopAd: true`; si no hay ventas, ninguno lleva `isTopAd: true`
- [ ] Pantalla "/attribution" no es accesible para `advisor` (403)
- [ ] Tests de aislamiento A↔B para el nuevo endpoint
- [ ] `pnpm check` verde

### 12.5 Orden de implementación

1. Migración nueva: columna `channel` en `contacts` + permiso `attribution.view` en `rbac/catalog.ts`
2. Schema Drizzle: añadir `channel` al objeto `contacts`
3. `AttributionService.recordAttribution` — derivar y grabar `channel`
4. Webhook: añadir `placement` al schema Zod
5. Tests de derivación de `channel`
6. Endpoint `GET /v1/attribution/ad-performance` + test de aislamiento
7. UI: badge de canal en `ContactDialog` › "Origen del lead"
8. UI: columna "Canal" opcional en la tabla de contactos
9. UI: pantalla `/attribution` con tabla, filtros y estrella dorada
10. `pnpm check` completo

---

## 13. Notas de implementación de §11 y §12 (2026-11-07)

Lo construido, y dónde se apartó del texto del plan porque el código real es distinto:

- **Migración `0126`** (la siguiente disponible): `contacts.channel` con el CHECK `contacts_channel_valid`, el permiso `attribution.view` (solo `client_admin`) y un relleno de los contactos que ya existían según su origen (manual→manual, whatsapp→whatsapp, meta_ctwa→facebook, el resto→other). La RLS sigue forzada (la regla P8 prohíbe quitarla, también en una migración): el relleno recorre las empresas poniendo cada una en contexto con `set_config('app.org_id', …, true)`, como lo hace la aplicación, y limpia el contexto al terminar.
- **El método real es `AttributionService.recordIn`** (el plan lo llama `recordAttribution`). El canal lo fija `ContactsService.setChannelOnCreate` solo cuando esa llamada acaba de crear el contacto; por eso un segundo clic nunca lo cambia. Un contacto que nace por un mensaje de WhatsApp sin anuncio queda en `whatsapp`; si ese primer mensaje trae el aviso de un anuncio (`referral`), queda en `facebook` (Meta no entrega la red en ese aviso: `instagram` solo llega con `placement` por el punto de entrada). La función pura es `channelOf` (`modules/contacts/contact-channel.ts`).
- **No existe un `ContactAttributionSchema` en `packages/shared`:** las formas viven en la API (`ContactView`, `ContactAttribution`) y en `apps/web/src/lib/types.ts`. El canal va en los dos sitios: `channel` en la ficha (siempre, también para contactos sin anuncio) y `attribution.channel`.
- **Endpoint:** `GET /v1/attribution/ad-performance` (`attribution.view`; parámetros estrictos; periodo por omisión de 30 días, máximo 366; 500 filas). Los nombres de la respuesta son los del plan (camelCase: `adName`, `isTopAd`…), distintos del resto de la API (snake_case), por decisión del plan aprobado. Agrupa por el id del anuncio y su nombre, conjunto, campaña y canal. «Ventas» cuenta contactos con la etiqueta del sistema «Venta» (como pide el plan), **no** las filas de `sales`: por eso puede diferir de la pestaña «Anuncio ganador» de Analítica (ADR-55), que cuenta ventas reales con sus ingresos.
- **Web:** insignia de canal (`ui/ChannelBadge`) en «Origen del lead» (solo se ve si el contacto tiene datos de atribución) y columna opcional «Canal» en Contactos; pantalla `/attribution` (tabla en escritorio, tarjetas en móvil, ★ dorada solo con al menos una venta, filtros de periodo y canal, estado vacío con enlace a Configuración › Atribución de Meta). La entrada del menú sigue la misma regla que «Configuración» (quien administra); si a un administrador se le quita el permiso por persona, la pantalla responde 403 y lo explica.
- **Sin validar:** la migración con filas reales (el relleno), el aviso real de Meta (si algún día trae la red del anuncio), navegador real.
