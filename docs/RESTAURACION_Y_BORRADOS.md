# Restaurar una copia de seguridad sin resucitar empresas borradas (ADR-59, F3c)

> Estado: **procedimiento escrito y con el guion probado contra PostgreSQL de pruebas (2026-11-03)**. Nunca se ha ejecutado contra una restauración real. Es una obligación operativa que el ADR-59 deja escrita: no hay forma técnica de evitarla.

## Por qué existe esto
Cuando una empresa se elimina, la dejamos 7 días «Eliminada» y luego la **borramos de forma definitiva** de producción (base de datos, archivos y sesiones de WhatsApp por QR). Pero:

- Las **copias de seguridad de la base de datos** (las del hosting) conservan los datos hasta que ellas mismas vencen, que es más tarde que los 7 días.
- Si algún día hay que **restaurar** una copia antigua, la base vuelve al pasado: una empresa que ya habíamos borrado reaparece **viva y con todos sus datos**, y su dueño podría volver a entrar.

Borrar de nuevo antes de reabrir el servicio es lo que cumple la promesa hecha al cliente («si alguna vez se restaura una copia, repetimos el borrado antes de volver a abrir el servicio»).

## Qué se conserva fuera de la base que se restaura
La lista de empresas purgadas vive en **tres lugares**, y solo hace falta uno:

1. **La auditoría de plataforma** de la base *actual* (`platform_audit`, acción `company.purged`), **antes** de sobrescribirla.
2. **El registro de la aplicación** (Railway › logs del servicio): cada borrado deja la línea `empresa borrada definitivamente` con `organizationId` y `deletionId`.
3. La propia base restaurada, **si la copia es posterior** al borrado (entonces la empresa ya viene como lápida `[empresa eliminada]`, y el guion la informa como `already_purged`).

## Procedimiento

> Hazlo con el servicio **cerrado al público** (la aplicación apagada o sin tráfico) y con la base restaurada ya apuntada por `DATABASE_URL_OWNER`.

### 1. Antes de restaurar: guardar la lista de empresas purgadas
Con la base **actual** (la que vas a reemplazar), como `app_platform` o con el superusuario de la base:

```sql
SELECT DISTINCT target_org_id
  FROM platform_audit
 WHERE action = 'company.purged'
 ORDER BY 1;
```

Guarda el resultado en un archivo de texto, **un id por línea** (puedes comentar con `#`). Si la base actual ya no existe o está dañada, saca los ids del registro de la aplicación (busca `empresa borrada definitivamente`) y de tu último respaldo de ese registro.

```text
# empresas purgadas hasta 2026-11-20
0190a000-0000-7000-8000-0000000000a1
0190a000-0000-7000-8000-0000000000b2
```

### 2. Restaurar la copia
Con el procedimiento de Railway (o del proveedor que se use). Aplica después las migraciones pendientes con `pnpm db:migrate` si la copia es de antes de una migración.

### 3. Reaplicar los borrados
```bash
DATABASE_URL_OWNER=<url del rol app_owner> pnpm db:reapply-purges empresas-purgadas.txt --actor <id de un Súper Admin>
```

- `--actor`: el id de un Súper Admin **que exista en la base restaurada**; queda como autor de la eliminación sintética.
- Por cada empresa del archivo el guion informa uno de estos resultados:
  - `purged` — la copia la trajo de vuelta y se volvió a borrar (negocio, identidad y lápida).
  - `already_purged` — ya venía como lápida: nada que hacer.
  - `not_found` — la copia es anterior a la empresa: nada que hacer.
  - `refused` — era la empresa «plataforma»: nunca se borra.
- Es **idempotente**: se puede repetir sin riesgo.
- Usa **las mismas funciones** que el borrado normal (`purge_company_step` y `purge_company_identity`), con las mismas defensas.

### 4. Comprobar y reabrir
1. Revisa la salida: ninguna línea de error y los `purged` esperados.
2. Corre `pnpm db:audit`: debe terminar **sin violaciones**.
3. Confirma en Consola › Empresas (filtro «Eliminadas») que las empresas purgadas figuran como borradas y que ninguna aparece activa.
4. Solo entonces reabre el servicio.

## Lo que este procedimiento NO cubre
- **Los archivos del almacenamiento (R2) y las instancias de Evolution no vuelven con la base**: seguían borrados y siguen así. Si por algún motivo se restaurara también el almacenamiento, hay que volver a borrar `org/<id>/` de cada empresa de la lista (en el panel de R2 o con el borrado por prefijo de la aplicación).
- **Las copias del hosting siguen guardando los datos** hasta que vencen. Hasta revisar en Railway cuánto duran, **no se debe prometer «borrado total e inmediato»**: la leyenda de ADR-59 dice «hasta [N] días adicionales».
- **Datos que cambiaron después de la copia** (ventas, mensajes, contactos de empresas que sí siguen vivas) se pierden con la restauración: esto solo evita resucitar las empresas borradas.

## Cada cuánto probarlo
Antes del piloto, hacer un ensayo completo en staging: borrar una empresa de prueba, tomar una copia **antes** del borrado, restaurarla en una base aparte y comprobar con `db:reapply-purges` que vuelve a quedar como lápida.
