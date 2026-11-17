# v17 — Campañas masivas · Plan de ejecución

> Preparado 2026-11-16. Fuente: prompt v17 (`SALES_SMART_2.0_PROMPT_CODE_V17_CAMPANAS_MASIVAS_ADR58.md`), **ADR-72** (APROBADO el 2026-11-16 con las recomendaciones; el prompt lo llamaba «ADR-58», número ya usado), Build Spec §5.2/§15 #17/§16, ADR-32/43/50/54 y el **prototipo v10** (`vCampaigns`, `openCampRes`, `campBases`, `capOf`), que manda en pantallas y reglas.
> Nombre: «v17 · Campañas» (rebanadas 17.1–17.5). No usa el nombre M11, reservado para «Telefonía y comisiones».

## 1. Estado verificado (Fase A, 2026-11-16)
| Pieza | Hallazgo |
|---|---|
| Migraciones | La última era la `0142`; las de campañas arrancan en la `0143` (el prompt decía 0107). |
| `OutreachService` | `sendTemplate` abre conversación (`outreach.service.ts:70`); `sendText` **no** (`textTarget` → `no_conversation`, línea 100). Hace falta «abrir y enviar texto» (17.4). |
| Cupo del QR | `qr-outbound.service.ts:213` cuenta todo mensaje saliente de la conexión en 24 h; el cupo se comparte solo. Se reserva el 30 % para conversaciones (ADR-72 #4). |
| Estados de entrega | `messages.status`, `delivered_at`, `read_at` ya los llenan los avisos de Meta y de Evolution; se derivan por destinatario. |
| Plan `campaigns` | Solo es un interruptor del catálogo (`plan-features.ts`); **nada lo exige**. Se construye `PlanFeaturesService`. |
| Parámetros de plantilla | `TemplatesService.prepare(row, params)` valida por clave (`body:1`, `button:0:1`); el mapa «variable → campo» se resuelve antes con el modelo de variables de las respuestas rápidas. |
| Consentimiento | Los contactos que escriben por WhatsApp y los importados nacen `unknown`; solo un formulario web los pasa a `granted`. Las automatizaciones solo excluyen `revoked`. |
| Alcance del asesor | Los contactos **no se comparten** (ADR-43: ve los asignados a él). El «Compartidos conmigo» del prototipo no existe en el modelo. |

## 2. Aceptación (del prompt §7)
- Un administrador crea una campaña oficial con plantilla aprobada a una lista, ve el conteo con omitidos y motivos, la lanza, ve avanzar los estados y descarga el CSV.
- Un asesor solo ve y envía a sus contactos, con su tope diario, y no ve campañas de otros.
- Un contacto `revoked` **jamás** recibe un mensaje de campaña (prueba que lo demuestre).
- La campaña por QR respeta pausa y cupo y se detiene sola si cae la sesión.
- Cancelar a mitad no envía más y deja el resto como omitido.
- Typecheck, lint, pruebas (incluida RLS) y aislamiento A↔B por endpoint, en verde.

## 3. Rebanadas (un PR cada una)
| | Qué | Estado |
|---|---|---|
| **17.1** | Modelo (`campaigns`, `campaign_recipients`, `campaign_advisor_limits`), permisos, bloqueo por plan, audiencia con vista previa (sin enviar), API `/v1/campaigns` y tope por asesor | construida 2026-11-16 |
| 17.2 | Pantalla «Campañas masivas» (una sola pantalla con cinco secciones, como el prototipo), vista previa, avisos de riesgo y de costo, tope por asesor en Equipo › Usuarios | construida 2026-11-16 |
| 17.3 | Envío por WhatsApp oficial: lanzar (congela la audiencia), tarea `campaign-sender`, pausar/reanudar/cancelar, programar, tope diario por empresa | pendiente |
| 17.4 | Envío por QR: «abrir y enviar texto», 45 s mínimo, cupo compartido con reserva, sesión caída ⇒ pausa | pendiente |
| 17.5 | Resultados por campaña y destinatario, CSV, baja por palabra clave, tarjeta en Analítica | pendiente |

## 4. Sin validar (declararlo en cada PR)
Plantillas de marketing contra Meta real, envío masivo real por Evolution (riesgo de bloqueo), volumen alto en la tarea, consentimiento `unknown` según la normativa local y el 70 % de reserva del cupo del QR.
