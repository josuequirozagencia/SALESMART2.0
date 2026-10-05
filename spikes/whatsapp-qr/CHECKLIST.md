# Checklist del spike (marcar con fecha y resultado)

| # | Prueba | Esperado | Resultado |
|---|---|---|---|
| A1 | Crear instancia + QR + escanear | `state` = open; evento CONNECTION_UPDATE | |
| A2 | Enviar texto al propio número | Llega; evento SEND_MESSAGE | |
| A3 | Recibir texto (otro teléfono → chip) | Evento MESSAGES_UPSERT con id, remitente, texto | |
| A4 | Enviar imagen por URL | Llega con caption | |
| A5 | Recibir imagen/audio/documento | Evento con media o forma de descargarla (anotar tamaño y vencimiento) | |
| A6 | Responder (cita) y reacción | Anotar estructura del evento | |
| A7 | Estados de entrega (enviado/entregado/leído) | MESSAGES_UPDATE con estados | |
| A8 | Mensaje duplicado: ¿el mismo `id` llega 2 veces? | Anotar (idempotencia) | |
| A9 | Grupo: crear/listar, enviar, `@todos`, agregar/quitar participante | GROUPS_UPSERT / GROUP_PARTICIPANTS_UPDATE; anotar límites | |
| B1 | Redeploy de `evolution` en Railway | Sigue conectado sin nuevo QR (volumen) | |
| B2 | Reiniciar instancia (`restart`) | Reconecta sola | |
| B3 | Reiniciar Redis / Postgres | Anotar si se pierde sesión o mensajes | |
| B4 | Apagar el teléfono del chip 24 h | Anotar desconexión/reconexión y eventos | |
| B5 | Webhook caído 5 min y reactivado | ¿Se pierden eventos? ¿Reintenta? | |
| B6 | Latencia: enviar → evento recibido (10 muestras) | Anotar p50/p95 | |
| C1 | Cerrar sesión desde el teléfono | Evento de logout; cómo detectarlo | |
| C2 | Seguridad: llamar a la API sin `apikey` | 401; no expuesta | |

Señales de riesgo a anotar: avisos de WhatsApp, bloqueos temporales, caídas sin evento, cambios entre versiones.
