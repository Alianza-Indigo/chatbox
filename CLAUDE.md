# Chatbox — WhatsApp Chatbot Platform

Multi-tenant WhatsApp chatbot platform backend. Clientes traen sus propias credenciales (LLM API keys, canal WhatsApp, Sentry DSN) — el backend no tiene claves globales de pago por cliente.

## Stack

- **Runtime**: Node.js + TypeScript + Fastify
- **DB**: PostgreSQL + Prisma + pgvector (ANN search, 1536-dim, cosine)
- **Queue**: BullMQ + Redis (inbound messages, DLQ)
- **Deploy**: Railway (2 servicios: API + Worker)

## Estructura clave

```
src/
  server.ts          — entry point HTTP
  worker.ts          — entry point BullMQ consumer
  migrate.ts         — entry point Railway releaseCommand
  app.ts             — Fastify app (swagger, metrics, sentry, requestId)
  config.ts          — zod env validation
  crypto.ts          — AES-256-GCM, kid versioning, encryptToBase64/decryptFromBase64
  db.ts              — Prisma client
  logger.ts          — pino
  openapi.ts         — OpenAPI 3.0 static spec
  lib/
    sentry.ts        — platform Sentry init + re-export
    pubsub.ts        — Redis pub/sub + getPubClient()
  queue/
    queue.ts         — BullMQ queues (messageQueue, dlq)
    producer.ts      — enqueueInboundMessage (cifra PII antes de Redis)
    consumer.ts      — startWorker (descifra PII, mutex por conversación)
  routes/
    webhook.ts       — POST /webhook/whatsapp/:phoneId (Meta Cloud API)
    admin/
      index.ts       — requireAuth + org isolation hook
      bots.ts        — CRUD bots
      channels.ts    — CRUD canales
      knowledge.ts   — CRUD + /embed endpoint
      organizations.ts — CRUD + sentryDsnEnc
      crypto.ts      — POST /admin/crypto/reencrypt (key rotation)
      dlq.ts         — GET/POST /admin/dlq (replay, purge)
      proactive.ts   — envío proactivo de mensajes
      integrations.ts
      feedback.ts
      users.ts
  services/
    conversation.service.ts  — flujo principal: crisis → quota → safety → LLM → send
    bot.service.ts           — loadChannelByPhoneId (con cache)
    knowledge.service.ts     — pgvector → cosine similarity → keyword fallback
    metrics.service.ts       — prom-client isolated registry
    tenant-sentry.service.ts — NodeClient por DSN, cache en Map
    audit.service.ts
    notification.service.ts
  providers/
    llm.ts           — getLLMProvider (anthropic, openai, …)
    channel.ts       — getChannelProvider (meta_cloud)
  middleware/
    auth.ts          — JWT + ADMIN_API_KEY superadmin bypass
```

## Decisiones de diseño importantes

### Seguridad / PII
- `from` y `textBody` se cifran con `encryptToBase64` en el producer **antes** de entrar a Redis/BullMQ
- El consumer descifra al inicio; los retries re-encolan `job.data` (cifrado), NO `jobData` (descifrado)
- Nunca loguear contenido de conversación, credenciales ni mensajes de crisis en claro

### Cifrado (crypto.ts)
- Wire format nuevo: `MAGIC(2) + KID(1) + IV(12) + TAG(16) + CIPHERTEXT`
- Legacy (sin MAGIC): `IV(12) + TAG(16) + CIPHERTEXT`
- `getStoredKid(data)` lee el KID sin descifrar — usado en `/admin/crypto/reencrypt`
- Rotación de llaves: `ENCRYPTION_KEYS={"0":"<base64>","1":"<base64>"}`, `ENCRYPTION_CURRENT_KID=1`

### Queue / BullMQ
- Deduplicación: `jobId: \`wa-${waMessageId}\`` — webhooks duplicados de Meta silenciados
- Mutex por conversación: `conv:${phoneId}:${from}` (por usuario, no por número de negocio)
- Retry lock: hasta 5 reintentos con backoff, luego drop + warn
- Lock TTL: 90s (cubre peor caso de latencia LLM)
- DLQ: jobs agotados se mueven ahí para inspección/replay manual

### Idempotencia
- Inbound messages: `db.message.upsert({ where: { externalId } })` — retry-safe
- Outbound messages: `db.message.create` — duplicación en retry es limitación conocida

### Sentry (dos instancias separadas)
- **Plataforma**: `SENTRY_DSN` env var → captura errores de infra (5xx, jobs agotados)
- **Tenant**: `Organization.sentryDsnEnc` cifrado → `captureTenantException(orgId, err)` → NodeClient aislado por DSN

### Knowledge / pgvector
- `embedding_vec vector(1536)` con HNSW index (cosine, m=16, ef_construction=64)
- Fallback: pgvector DB → cosine similarity in-process → keyword search
- Sin soporte nativo Prisma para vector — todo raw SQL

### Crisis detection
- Detector independiente del LLM del cliente (reglas controladas por la plataforma)
- Se ejecuta **antes** de llamar al LLM
- Registra `crisisEvent` en DB con `actionTaken`
- Usa `crisisConfig` del bot (líneas por país) o fallback México (SAPTEL, Línea de la Vida)

### Métricas
- `prom-client` con registry aislado (no global)
- `/metrics` protegido con `x-admin-key` header
- Exporta: duración LLM, tokens, costos, errores LLM/Meta, quota blocks, safety blocks, DLQ depth

## Variables de entorno requeridas

```env
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JWT_SECRET=<64-char random>
ADMIN_API_KEY=<random>
NODE_ENV=production
ENCRYPTION_KEYS={"0":"<32-byte base64>"}
ENCRYPTION_CURRENT_KID=0
META_VERIFY_TOKEN=<webhook verify token>
# Opcionales
SENTRY_DSN=<platform Sentry>
WEBHOOK_ALERT_URL=<Slack/Discord webhook>
```

## Railway deployment

- **Servicio API**: usa `railway.toml` tal cual. `releaseCommand = "node dist/migrate.js"` corre migraciones antes del deploy.
- **Servicio Worker**: crear manualmente en Railway UI → mismo repo → `startCommand = "node dist/worker.js"` → sin healthcheck ni puerto público.
- Ambos servicios comparten `DATABASE_URL` y `REDIS_URL`.

## Tests

```bash
npm test        # 110 tests, 8 suites
```

Suites:
- `resilience.test.ts` — lock isolation, idempotency, dedup, PII encryption
- `conversation.crisis.test.ts` — crisis flow, LLM bypass, fallback lines
- `knowledge.test.ts` — pgvector → cosine → keyword fallback chain
- `safety.test.ts` — SafetyClassifier (independiente del LLM cliente)
- `auth.test.ts` — JWT + superadmin bypass
- `isolation.test.ts` — org isolation middleware
- `quota.test.ts` — rate limiting por org
- `stt.test.ts` — Speech-to-text provider

## Pendientes (no bloqueantes para Railway)

- **DLQ TTL**: BullMQ no tiene TTL nativo para jobs en espera — revisar manualmente vía `/admin/dlq` o cron externo
- **Message.bodyEnc re-encryption**: `/admin/crypto/reencrypt` lo excluye explícitamente — requiere backfill async paginado para datasets grandes
- **Runbooks (P2)**: incident, key rotation, DLQ replay, backup/restore — documentación operacional pendiente
