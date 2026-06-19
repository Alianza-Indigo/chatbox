# Chatbox — Multi-bot WhatsApp Platform

Backend multi-tenant para desplegar chatbots de WhatsApp con credenciales propias del cliente (BYO), clasificación de seguridad independiente y cumplimiento LFPDPPP/ARCO.

## Arquitectura

```
┌─────────────────┐     ┌─────────────────┐
│  Fastify (web)  │     │  BullMQ (worker) │
│  POST /webhook  │────▶│  message queue   │
│  /auth          │     │  concurrency=10  │
│  /admin         │     └────────┬─────────┘
└─────────────────┘              │
         │                       ▼
         └──────────┬── PostgreSQL (Prisma)
                    └── Redis (BullMQ)
```

- **Web**: recibe webhooks de Meta, rutas de administración REST (JWT)
- **Worker**: procesa mensajes async — safety check → LLM → respuesta

## Requisitos

- Node.js 20+
- PostgreSQL 15+
- Redis 7+

## Instalación local

```bash
git clone <repo>
cd chatbox
npm install
cp .env.example .env   # edita con tus valores reales
npm run db:generate
npm run db:migrate
```

## Variables de entorno

Ver `.env.example` para la lista completa. Las mínimas requeridas para arrancar:

| Variable | Descripción |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `FIELD_ENCRYPTION_KEY` | Clave AES-256-GCM para cifrar credenciales (ver abajo) |
| `META_APP_SECRET` | App Secret de Meta para verificar webhooks |
| `WEBHOOK_VERIFY_TOKEN` | Token de verificación del webhook de Meta |
| `JWT_SECRET` | Secreto para firmar tokens JWT |
| `ADMIN_API_KEY` | Clave de superadmin (header `x-admin-key`) |
| `SUPERADMIN_EMAILS` | Correos separados por comas con acceso superadmin por login |

## Correr en desarrollo

```bash
# Terminal 1 — servidor HTTP
npm run dev

# Terminal 2 — worker de mensajes
npm run dev:worker
```

## Docker (desarrollo local)

```bash
# Copia y edita .env primero (DATABASE_URL y REDIS_URL son sobreescritos por docker-compose)
cp .env.example .env

docker compose up --build
```

Levanta PostgreSQL, Redis, el servidor HTTP en `:3000` y el worker.

## Producción (Railway)

1. Crear dos servicios en Railway apuntando al mismo repositorio
2. **Servicio web** — usa `railway.toml` tal cual (startCommand por defecto)
3. **Servicio worker** — override startCommand: `node dist/worker.js`
4. Configurar variables de entorno en ambos servicios (las mismas)

Railway ejecuta automáticamente `prisma migrate deploy` antes de arrancar el servidor web.

## Scripts disponibles

| Script | Descripción |
|--------|-------------|
| `npm run dev` | Servidor de desarrollo con hot reload |
| `npm run dev:worker` | Worker de desarrollo con hot reload |
| `npm run build` | Compila TypeScript → `dist/` |
| `npm start` | Servidor de producción |
| `npm run worker` | Worker de producción |
| `npm run db:migrate` | Aplica migraciones pendientes |
| `npm run db:generate` | Regenera el cliente Prisma |
| `npm run db:studio` | Abre Prisma Studio (GUI) |
| `npm test` | Ejecuta tests |
| `npm run lint` | Type-check TypeScript |

## FIELD_ENCRYPTION_KEY — Gestión de la clave maestra

Esta clave cifra **todas** las credenciales por bot (llm_api_key, channel credentials, integrations). Si se pierde, los datos cifrados son irrecuperables.

### Generar

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Backup

Guardar en un gestor de secretos (Railway Variables, AWS Secrets Manager, Vault, Bitwarden) **antes** de usarla en producción. Nunca en el repositorio.

### Rotación de clave

La clave actual no admite rotación sin re-cifrar todos los registros. Procedimiento:

```bash
# 1. Exportar todos los valores cifrados con la clave antigua
# 2. Descifrarlos con la clave antigua
# 3. Generar nueva FIELD_ENCRYPTION_KEY
# 4. Re-cifrarlos con la nueva clave y actualizar la DB
# 5. Rotar la variable de entorno en todos los servicios simultáneamente
```

Una rotación mal ejecutada (cambiar la env var sin re-cifrar primero) deja todos los bots con error de credenciales. Asegúrate de hacer el re-cifrado en una transacción antes de cambiar la clave en producción.

## Seguridad

- Webhook verificado con HMAC SHA-256 + `timingSafeEqual` (anti timing-attack)
- Rate limiting: 60 req/min en `/webhook`, 300 req/min global
- Credenciales cifradas con AES-256-GCM (autenticado), nunca en claro en logs
- Safety classifier independiente del LLM del cliente (`SAFETY_PROVIDER_API_KEY`)
- JWT 7 días + bypass superadmin por `x-admin-key`
- Aislamiento por organización en todas las rutas admin

## Cumplimiento (LFPDPPP / ARCO)

- Teléfonos de usuarios almacenados como SHA-256 hash (nunca en claro)
- Derecho de supresión: `DELETE /admin/:botId/users/:userId/data` borra todos los datos del usuario en cascada
- Consentimiento explícito requerido antes de cualquier interacción
- `POLICY_VERSION` configurable para re-solicitar consentimiento al cambiar la política
