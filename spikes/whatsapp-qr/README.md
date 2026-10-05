# Spike WhatsApp QR (Evolution API) — ADR-31

**Desechable.** Objetivo: aprender cómo se comporta Evolution API con un número real antes de escribir `EvolutionProvider`. No toca `apps/`.

## Reglas de seguridad del spike
1. **Solo un chip de prueba dedicado.** Nunca el número de un cliente ni el principal de la agencia: WhatsApp puede bloquear números vinculados por QR.
2. Envía solo a números propios o de personas que lo saben (2–3 contactos). Nada masivo, nada de pruebas de volumen.
3. Claves largas y aleatorias (`openssl rand -hex 24`); `.env` no se sube a GitHub. Evolution no debe quedar expuesto sin `apikey`.
4. Los mensajes del chip de prueba quedan en la base de Evolution: usa conversaciones de prueba.

## A) Prueba local (Docker)
```bash
cd spikes/whatsapp-qr
cp .env.example .env        # rellena EVOLUTION_API_KEY, EVO_DB_PASSWORD, WEBHOOK_TOKEN, TEST_NUMBER
docker compose up -d
node --env-file=.env scripts/evo.mjs create
node --env-file=.env scripts/evo.mjs qr      # abre qr.png y escanea desde el chip de prueba
node --env-file=.env scripts/evo.mjs state   # esperado: "open"
node --env-file=.env scripts/evo.mjs send-text "hola desde el spike"
tail -f events.jsonl                         # eventos recibidos por webhook
```

## B) Prueba en Railway (lo que importa: persistencia y redeploy)
Crear un proyecto Railway **de pruebas** (no el de producción) con 4 servicios:
1. **Postgres** (plantilla de Railway). Variable de conexión → `DATABASE_CONNECTION_URI` de Evolution.
2. **Redis** (plantilla de Railway) → `CACHE_REDIS_URI=redis://…/1`.
3. **evolution**: imagen Docker `atendai/evolution-api:v2.1.1`, puerto 8080, variables de `docker-compose.yml`, `SERVER_URL` = dominio público generado, y un **volumen persistente montado en `/evolution/instances`** (sin esto se pierde la sesión QR en cada deploy).
4. **receiver**: este mismo directorio (comando `node scripts/webhook-receiver.mjs`) con `WEBHOOK_TOKEN`; usa su URL privada interna como `WEBHOOK_URL` (`http://receiver.railway.internal:4000/hook`).

Luego ejecuta los mismos comandos de A) con `EVO_URL` apuntando al dominio de Railway. **Pruebas B1–B4 de `CHECKLIST.md`** (redeploy, reinicio, caída de Redis) son el corazón del spike.

## Qué entrego al terminar
`INFORME.md` con la tabla de resultados del checklist, hallazgos, riesgos y recomendación para `EvolutionProvider` (qué mapear a `NormalizedMessage`, qué eventos escuchar, cómo reconectar). El orden de hitos no cambia sin tu aprobación.
