# Auditoría de estado — 2026-10-30

Revisión del repositorio, la documentación y el staging al cerrar M5.8 y aprobar el ADR-56. Es una auditoría **de estado** (qué está hecho, aprobado, validado y pendiente), no una revisión de seguridad externa. Cada afirmación dice cómo se comprobó; lo que no se pudo comprobar se dice como tal.

## 1. Lo comprobado
| Qué | Resultado | Cómo se comprobó |
|---|---|---|
| Rama `main` | `4b4a2f5` (merge del PR #2, M5.8), CI del PR en verde | `gh run view`, `git log` |
| Migraciones | 104 archivos (`0000`–`0103`); staging al día (104 aplicadas el 2026-10-28) | `ls apps/api/src/db/migrations`, auditoría del 2026-10-28 contra staging |
| Auditoría de catálogo PostgreSQL (ADR-24) | sin violaciones en staging y en CI | `pnpm db:audit` (CI) y a mano contra staging |
| Rutas | 285 entradas en el registro de endpoints; la CI falla si una ruta no está registrada o no tiene su prueba de aislamiento | `test/support/endpoint-registry.ts` |
| Dependencias | **0 vulnerabilidades** de gravedad moderada o mayor | `pnpm audit --audit-level moderate` (2026-10-30) |
| Pruebas | 150 archivos de prueba; web 715 + las nuevas de M10.1; API: suites por carpeta verdes en local; E2E local 40/40 | corridas del 2026-10-30 |
| Staging | `GET /health` 200; el último despliegue incluye el procesamiento inmediato de avisos del QR | `curl`, CI de `12437bb` en verde |
| Evolution (WhatsApp QR) | responde 200; la clave global funciona (200 con clave, 401 sin ella) | `curl` el 2026-10-29 |

## 2. Aprobaciones y estado de los ADR
- **Todos los ADR 01–54 están aprobados**, salvo un resto: en ADR-51, las precisiones de **M6.5 «Descargas»** (decisión 2 cambiada por el responsable el 2026-10-24 y lo que de ella nace) figuran como **PROPUESTAS** y `CLAUDE.md` lo repite. **Acción:** aprobarlas o corregirlas (es lo único aprobado «de palabra» sin registro).
- **ADR-23** no tiene línea «Estado» en su encabezado (el formato difiere de los demás); su contenido se usa y se cita como aprobado en ADR-29/33. **Acción menor:** añadir la línea.
- **ADR-55** (integraciones, historial de toques y «Anuncio ganador») está **propuesto en la rama `docs/propuesta-adr55`** y aprobado de palabra el 2026-10-26; todavía **no está registrado en `docs/ADR.md`** (es el bloque C pendiente).
- **ADR-56** (equipo y navegación) quedó **aprobado el 2026-10-30** y registrado.

## 3. Inconsistencias entre documentos
1. **Numeración de hitos.** `BUILD_SPEC` §14 llama **M10** a «Telefonía y comisiones»; el ADR-56 usa **M10.1–M10.6** para Equipo y navegación (el responsable pidió ese nombre). El ADR-56 propone que «Telefonía y comisiones» pase a **M11 — Comisiones** (telefonía diferida) y «Voz IA» a M12. **Pendiente de confirmar** y de corregir en §14.
2. **`CLAUDE.md` es largo y crece por acumulación** (el archivo ocupa unos 58 KB y casi todo es la sección «Estado del trabajo»). Sigue siendo correcta, pero cuesta de leer y de mantener. **Recomendación:** moverlo a `docs/ESTADO.md` por hitos y dejar en `CLAUDE.md` solo las reglas y un resumen de una línea por hito.
3. **`team.manage`** figura en el catálogo y en `BUILD_SPEC` §5 sin ninguna pantalla ni ruta que lo use; el ADR-56 lo reemplaza por `users.manage` (se corrige al construir M10.3).
4. **«Decisiones aún abiertas»** en `CLAUDE.md` sigue incluyendo «valores de ejemplo de créditos y retención de prueba» y «validación en Events Manager de retirar eventos de Meta»: siguen abiertas.
5. **ADR-31 (spike de WhatsApp QR)**: el informe quedó PARCIAL (B4 teléfono apagado, A8 duplicados, A9 grupos sin probar) y el canal ya está construido. El riesgo está documentado, pero el ADR no lo refleja.

## 4. Lo «construido pero sin validar contra el proveedor real»
Es lo más importante para el piloto: todo esto pasa sus pruebas con simuladores, **no con el servicio real**.

| Integración | Qué falta validar |
|---|---|
| WhatsApp oficial (Meta) | Envío y recepción reales: **probados a mano por el responsable el 2026-10-21 («todo OK», sin informe por punto)**. Sin validar: audio, adjuntos reales, **reacciones** (y quitarlas con emoji vacío), **nota de voz `webm`** (Meta puede exigir `ogg/opus`: requiere conversión con ffmpeg) |
| WhatsApp QR (Evolution) | Envío de archivos y notas de voz, errores exactos del servidor, citas, duplicados, teléfono apagado, bloqueo del número y tiempos con carga real; **primer uso con chip desechable hecho el 2026-10-29: texto y envío OK** |
| API de Conversiones (Meta) | Formato de `user_data` de mensajería; eventos de prueba en Events Manager |
| GoHighLevel | Cabecera `Version`, scopes, forma de `/workflows/`, campos del Workflow, cuerpo de `/conversations/messages` |
| OpenAI (IA) | Formato de respuestas y `tool_calls`, costos, umbral de parecido (0,30 provisional), **que el modelo obedezca la orden «sin respaldo»** |
| Almacenamiento (R2), antivirus (ClamAV), conversión de audio (ffmpeg) | Todo: hoy `none`/simulado en el piloto |
| Correo (Resend) y Turnstile | Envío real y desafío en navegador real |
| Acción HTTP de automatizaciones | Conexión TLS real contra un servidor público (probar primero en staging) |
| Navegadores y lectores de pantalla | Las pantallas nuevas se probaron con pruebas de componentes y E2E de acceso/bandeja; no hay revisión manual en móviles ni con lector de pantalla |

## 5. Riesgos operativos y de seguridad (staging)
1. **Evolution API está expuesto a Internet** (`/` responde 200 y `/manager` redirige): solo la clave global lo protege. **Acción:** mover el servicio a red privada o restringir `/manager`; rotar la clave si se sospecha exposición.
2. **El proyecto de pruebas del spike en Railway** sigue vivo y **el chip estuvo vinculado a él**; su clave y el token del webhook se vieron en logs durante el spike. **Acción:** borrar ese proyecto o rotar sus claves (ya se avisó).
3. **`PROVIDER_CREDENTIALS_KEY`**: opcional hoy, **obligatoria antes de abrir a usuarios reales** (ADR-42). Estado en staging: cargada; no hay procedimiento probado de rotación en caliente.
4. **Parámetros `AUTH_*` y retenciones de limpieza de identidad** siguen provisionales («calibrar antes de producción»).
5. **Backups y restauración**: no hay evidencia en el repositorio de una restauración probada del Postgres de staging (ADR-30 lo exige antes de producción).
6. **Un solo proceso**: tiempo real (Socket.IO) y tareas periódicas corren en el mismo proceso, sin Redis. Correcto para el piloto; limita escalar a varias instancias (los avisos en vivo no cruzarían instancias).
7. **Credenciales en el entorno local del desarrollador** (`~/.salesmart-secrets`): fuera del repositorio y de git; no se imprimieron en esta revisión.
8. **Dominio definitivo** `app.growthconsulting.digital` depende de un CNAME aún sin confirmar; `FRONTEND_BASE_URL` apunta ya a él (los enlaces de invitación y webhooks lo usan).

## 6. Calidad de las pruebas
- Obligatorias por política: aislamiento A↔B por endpoint (cumplido: lo exige la CI), dinero y autenticación (cubiertos).
- **Huecos conocidos:** sin E2E propio de M5.8, de las pantallas de formularios, automatizaciones, IA y QR (solo pruebas de componentes y de API); entre 8 y 9 fallos esperados de la suite local por PostgreSQL 13/Windows que **pasan en CI** (PG 16); una prueba web de listas es lenta (≈20 s) y falla por tiempo cuando la máquina está cargada.
- **Verde en CI** es la referencia: PostgreSQL 16, PgBouncer real, Node 22.

## 7. Pendientes del responsable (no los puede hacer el código)
1. Aprobar las precisiones de **M6.5 «Descargas»** y confirmar la **numeración M10/M11**.
2. Clave real de OpenAI; almacenamiento R2; precios de modelos y valor del crédito.
3. Validar con cuentas reales: GHL, Meta CAPI, Turnstile, Resend; probar la acción HTTP contra un webhook público.
4. `TURNSTILE_SITE_KEY` en Railway; confirmar el CNAME del dominio.
5. Spike de QR: B4, A8 y A9; borrar o rotar el proyecto de pruebas.
6. Elegir pasarela de pago, PoC de voz (Retell o Vapi) y retención de grabaciones (siguen abiertas).
7. Borrar la carpeta suelta `C:\JOSUEQ~1`.

## 8. Recomendaciones (en orden)
1. Cerrar los dos registros que faltan (M6.5 y ADR-55) para que `docs/ADR.md` sea la única fuente.
2. Cerrar el riesgo de Evolution (red privada o `/manager` cerrado) antes de conectar chips de clientes.
3. Antes del piloto con clientes: una **prueba de restauración de backup**, la clave de cifrado obligatoria y una **ronda de validación con proveedores reales** (sección 4), empezando por OpenAI y la nota de voz de WhatsApp.
4. Dividir `CLAUDE.md` en reglas (corto) y estado por hitos (`docs/ESTADO.md`).
5. Un E2E de «un día de asesor» (entra un mensaje, se reparte, se responde, se agenda y se vende) que cubra M5–M6 de punta a punta.
