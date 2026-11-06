# Revisión funcional tras la alineación con v10 (Fase 4 del prompt v3)

Fecha: 2026-11-06. La alineación solo tocó interfaz (`apps/web`): ninguna fila cambió de lógica ni de API. Cada fila apunta a la prueba que la cubre (API = Vitest con PostgreSQL real; Web = Vitest/jsdom; E2E = Playwright en la CI). Lo que no se puede probar sin aparatos reales se anota como **no validado**.

| Función | Qué se comprueba | Prueba |
|---|---|---|
| Estados de conversación | Trabajando / Esperando (antes «Pendientes») / Finalizadas cambian al aceptar, transferir y finalizar | API `inbox/inbox.test.ts`; Web `inbox.test.tsx` (pestañas y conteos); E2E «inbox: un cliente escribe, el asesor acepta…» |
| Aceptar / tomar / transferir / compartir | Dueño, colaboradores y aviso automático (nota interna del sistema) | API `inbox/sharing.test.ts`; E2E «compartir (solo ver) y transferir…» |
| Asignación y reparto | Horario y tope diario intactos | API `queues/queues.test.ts`, `team/team.test.ts` |
| SLA y cronómetros | Chip, reasignación por falta de respuesta | API `inbox/sla.test.ts`; E2E «SLA: el administrador configura…» |
| Respuesta dentro de 24 h | 409 `WINDOW_CLOSED` y plantillas | API `inbox/inbox.test.ts`, `templates/templates.test.ts`; Web `inbox.test.tsx` |
| Plantillas, respuestas rápidas, programados | Mismo resultado al enviar, variables resueltas en el servidor | API `templates`, `quick-replies`, `scheduled/*`; Web `quick-replies.test.tsx` |
| Nota interna | Nunca sale a WhatsApp | API `inbox/inbox.test.ts`; Web `inbox-mobile-chat.test.tsx` (nota por `POST …/notes`) |
| Adjuntos y nota de voz | Subida, envío, reproducción | API `attachments/*`; Web `attachments.test.tsx`. **No validado:** nota de voz `webm` contra Meta |
| Reacciones | Sobre el mensaje, sin mover la conversación | API `inbox/reactions.test.ts` |
| Agente de IA | Banner, pausar/reanudar, pase a persona | API `ai/agent-runtime.test.ts`; Web `agent-banner.test.tsx`, `inbox-mobile-chat.test.tsx` |
| Etiquetas | Ver abajo | API `lists/lists.test.ts`; Web `inbox-m58.test.tsx` |
| Panel de contacto | Campos, responsable, cita, oportunidad, ventas, notas, tareas | Web `inbox-m58.test.tsx` (columna), `inbox-layout.test.tsx` |
| Tiempo real | Llegan mensajes y estados sin recargar; respaldo por consulta | API `realtime/realtime.test.ts`; Web `realtime.test.tsx` |
| Permisos | El asesor no ve lo que no le toca; el administrador ve todo | API `inbox/inbox.test.ts`, `isolation/*`; Web `nav-redesign.test.tsx` (menú por rol), `view-as.test.tsx` |
| «Ver como» (icono) | Solo reduce permisos; solo lectura | Web `view-as.test.tsx`; E2E «ver como (M10.5)» |

## Etiquetas (§7)
- **Quitar de un contacto o conversación:** cada etiqueta **personalizada** muestra un × (cabecera del chat, hoja de acciones móvil y panel de contacto); las del sistema no. Usa `PATCH /contacts/:id { tag_ids }` (el servidor reemplaza el conjunto de personalizadas). Web `inbox-m58.test.tsx` («cada etiqueta personalizada lleva un ×…»).
- **Borrar del catálogo:** el botón «Borrar» solo existe para personalizadas; el texto aclara que se quita de todos los contactos y conversaciones. Web `lists.test.tsx`.
- **El servidor protege las del sistema** (409 `TAG_SYSTEM` al editar o borrar; rechaza `tag_ids` del sistema, borrados, inexistentes o repetidos; no deja nada a medias): API `lists/lists.test.ts` (líneas «rechaza etiquetas del sistema…» y `TAG_SYSTEM`).
- **Aislamiento A↔B:** API `lists/lists.test.ts` («aislamiento A↔B: una etiqueta o un campo de A no filtran nada en B»).
- **Auditoría** de los cambios y **GoHighLevel** (la quita se propaga con anti-eco): API `lists.test.ts` («se audita») y `ghl/*` (bus de etiquetas, M7.3). **No validado contra GHL real.**
- **Sin cambios de API ni de permisos.**
