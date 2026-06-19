export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Chatbox API',
    version: '1.1.0',
    description:
      'Multi-tenant WhatsApp chatbot platform — LLM-agnostic, BYO credentials. ' +
      'All bot LLM API keys, channel tokens, and integration secrets are encrypted at rest ' +
      '(AES-256-GCM, KID versioning) and never returned by the API.',
    contact: { email: 'support@chatbox.app' },
  },
  servers: [{ url: '/api/v1', description: 'Current environment' }],
  tags: [
    { name: 'System', description: 'Health and metrics' },
    { name: 'Auth', description: 'Registration and JWT authentication' },
    { name: 'Webhook', description: 'Meta Cloud API webhook endpoints (public)' },
    { name: 'Bots', description: 'Bot configuration — system prompt, LLM, safety, branding, commands, crisis' },
    { name: 'Channels', description: 'WhatsApp channel management per bot' },
    { name: 'Knowledge', description: 'Bot knowledge base items and embeddings' },
    { name: 'Integrations', description: 'Third-party integrations (STT, etc.) per bot' },
    { name: 'Users', description: 'End-user management, ARCO compliance, crisis events' },
    { name: 'Feedback', description: 'User ratings on bot responses' },
    { name: 'Proactive', description: 'Admin-initiated proactive messages via Meta templates' },
    { name: 'Organizations', description: 'Organization CRUD, members, audit log' },
    { name: 'DLQ', description: 'Dead-letter queue inspection and replay (superadmin)' },
    { name: 'Crypto', description: 'Key rotation re-encryption utilities (superadmin)' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT obtained from POST /auth/login',
      },
      adminKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-admin-key',
        description: 'Static admin API key (ADMIN_API_KEY env var). Grants superadmin access; bypasses JWT.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          details: { type: 'object' },
        },
      },
      Bot: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          status: { type: 'string', enum: ['draft', 'active', 'paused', 'credential_error'] },
          locale: { type: 'string', example: 'es-MX' },
          systemPrompt: { type: 'string', nullable: true },
          identity: { type: 'object', nullable: true, description: 'Persona JSON (name, tone, style)' },
          onboardingMsg: { type: 'string', nullable: true },
          historyWindow: { type: 'integer', minimum: 0, description: 'Number of turns of conversation history sent to LLM' },
          llmProvider: { type: 'string', enum: ['openai', 'anthropic', 'google', 'mistral'], nullable: true },
          llmModel: { type: 'string', nullable: true },
          llmApiKeySet: { type: 'boolean', description: 'True when an LLM API key is stored encrypted; key itself is never returned' },
          llmParams: { type: 'object', nullable: true, description: 'Extra LLM parameters (temperature, max_tokens, etc.)' },
          safetyLevel: { type: 'string', enum: ['strict', 'standard', 'minimal'] },
          webhookRateLimit: { type: 'integer', nullable: true, description: 'Per-bot webhook rate limit (req/min). null = global default (60)' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      BotBranding: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          botId: { type: 'string', format: 'uuid' },
          companyName: { type: 'string', nullable: true },
          logoUrl: { type: 'string', nullable: true },
          primaryColor: { type: 'string', nullable: true, example: '#3B82F6' },
          website: { type: 'string', nullable: true },
          supportContact: { type: 'string', nullable: true },
          privacyPolicyUrl: { type: 'string', nullable: true },
          termsUrl: { type: 'string', nullable: true },
        },
      },
      BotCommand: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          botId: { type: 'string', format: 'uuid' },
          trigger: { type: 'string', description: 'Exact text that activates the command (e.g. "/help")' },
          responseType: { type: 'string', enum: ['static', 'action'] },
          payload: { type: 'object', description: 'Response payload; shape depends on responseType' },
        },
      },
      CrisisConfig: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          botId: { type: 'string', format: 'uuid' },
          country: { type: 'string', example: 'MX' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                phone: { type: 'string' },
                hours: { type: 'string', nullable: true },
              },
            },
          },
          enabled: { type: 'boolean' },
        },
      },
      PromptVersion: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          botId: { type: 'string', format: 'uuid' },
          version: { type: 'integer' },
          systemPrompt: { type: 'string' },
          createdBy: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Channel: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          botId: { type: 'string', format: 'uuid' },
          provider: { type: 'string', enum: ['meta_cloud', 'embedded_signup'], description: 'Channel provider identifier' },
          phoneId: { type: 'string', description: 'Meta phone_number_id' },
          verifyToken: { type: 'string' },
          status: { type: 'string', enum: ['connected', 'pending', 'error'] },
        },
      },
      Integration: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          botId: { type: 'string', format: 'uuid' },
          kind: { type: 'string', enum: ['stt'], description: 'Integration category' },
          provider: { type: 'string', example: 'openai' },
          status: { type: 'string', enum: ['active', 'disabled'] },
        },
      },
      KnowledgeItem: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          botId: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          hasEmbedding: { type: 'boolean' },
        },
      },
      KnowledgeUploadResult: {
        type: 'object',
        properties: {
          sourceTitle: { type: 'string' },
          sourceType: { type: 'string', enum: ['pdf', 'docx', 'txt', 'csv', 'xlsx', 'xls', 'png', 'jpg', 'jpeg', 'webp'] },
          created: { type: 'integer' },
          embedded: { type: 'integer' },
          failed: { type: 'integer' },
          totalChunks: { type: 'integer' },
        },
      },
      Organization: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          plan: { type: 'string', enum: ['free', 'pro', 'enterprise'] },
          msgQuota: { type: 'integer', description: '0 = unlimited' },
          msgUsed: { type: 'integer' },
          currentPeriodStart: { type: 'string', format: 'date-time' },
          msgRetentionDays: { type: 'integer', nullable: true, description: 'Message retention policy in days. null = keep forever' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      OrgMember: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
          role: { type: 'string', enum: ['owner', 'admin', 'editor'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      AuditLogEntry: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid', nullable: true },
          actorId: { type: 'string', nullable: true },
          actorRole: { type: 'string', nullable: true },
          action: { type: 'string', example: 'bot.update_credentials' },
          targetType: { type: 'string' },
          targetId: { type: 'string', nullable: true },
          metadata: { type: 'object', nullable: true },
          ip: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      EndUser: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          botId: { type: 'string', format: 'uuid' },
          locale: { type: 'string', nullable: true },
          paused: { type: 'boolean' },
          freeMsgUsed: { type: 'integer' },
          membershipUntil: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Payment: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          botId: { type: 'string', format: 'uuid' },
          endUserId: { type: 'string', format: 'uuid' },
          provider: { type: 'string', example: 'mercadopago' },
          status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
          amount: { type: 'number', nullable: true },
          currency: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          paidAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      CrisisEvent: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          botId: { type: 'string', format: 'uuid' },
          detectedAt: { type: 'string', format: 'date-time' },
          category: { type: 'string', example: 'suicide_risk' },
          actionTaken: { type: 'string', example: 'resources_sent' },
        },
      },
      Feedback: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          messageId: { type: 'string', format: 'uuid' },
          rating: { type: 'integer', minimum: 1, maximum: 5 },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      DLQJob: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          data: {
            type: 'object',
            properties: {
              phoneId: { type: 'string' },
              waMessageId: { type: 'string' },
              messageType: { type: 'string' },
              timestamp: { type: 'number' },
            },
          },
          failedReason: { type: 'string' },
          attemptsMade: { type: 'integer' },
          addedAt: { type: 'string', format: 'date-time' },
        },
      },
      ReencryptResult: {
        type: 'object',
        properties: {
          currentKid: { type: 'integer' },
          reencrypted: { type: 'integer' },
          skipped: { type: 'integer' },
          failed: { type: 'integer' },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    // ── System ──────────────────────────────────────────────────────────────────
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check',
        description: 'Probes DB and Redis connectivity. Used by Railway readiness checks.',
        security: [],
        responses: {
          200: {
            description: 'All dependencies healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['ok', 'degraded'] },
                    db: { type: 'boolean' },
                    redis: { type: 'boolean' },
                    ts: { type: 'number' },
                  },
                },
              },
            },
          },
          503: { description: 'One or more dependencies degraded' },
        },
      },
    },
    '/metrics': {
      get: {
        tags: ['System'],
        summary: 'Prometheus metrics',
        description: 'Returns metrics in Prometheus text exposition format. Protected by x-admin-key header.',
        security: [{ adminKey: [] }],
        responses: {
          200: { description: 'Prometheus text format', content: { 'text/plain': { schema: { type: 'string' } } } },
          401: { description: 'Unauthorized' },
        },
      },
    },

    // ── Auth ────────────────────────────────────────────────────────────────────
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Register a new user and org',
        description: 'Creates both the OrgUser account and the parent Organization in a single call. Rate-limited to 5 req/h.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password', 'orgName'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 8 },
                  orgName: { type: 'string', minLength: 1 },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'User and org created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    token: { type: 'string', description: 'JWT bearer token' },
                    userId: { type: 'string', format: 'uuid' },
                    orgId: { type: 'string', format: 'uuid' },
                  },
                },
              },
            },
          },
          409: { description: 'Email already registered', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Authenticate and obtain a JWT',
        description: 'Rate-limited to 10 req / 15 min to mitigate brute-force attacks.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'JWT token',
            content: { 'application/json': { schema: { type: 'object', properties: { token: { type: 'string' } } } } },
          },
          401: { description: 'Invalid credentials', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Webhook ─────────────────────────────────────────────────────────────────
    '/webhook': {
      get: {
        tags: ['Webhook'],
        summary: 'Meta webhook verification challenge',
        description: 'Meta sends a GET with hub.mode=subscribe and hub.verify_token. Returns hub.challenge on success.',
        security: [],
        parameters: [
          { name: 'hub.mode', in: 'query', schema: { type: 'string' } },
          { name: 'hub.verify_token', in: 'query', schema: { type: 'string' } },
          { name: 'hub.challenge', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'Challenge echoed back to Meta' },
          403: { description: 'Verify token mismatch' },
        },
      },
      post: {
        tags: ['Webhook'],
        summary: 'Receive inbound messages from Meta',
        description:
          'Validates the x-hub-signature-256 HMAC signature, then enqueues inbound messages to BullMQ (PII encrypted). ' +
          'Rate-limited to 60 req/min. Returns 200 immediately so Meta does not retry. ' +
          'Replay protection: messages with timestamps older than WEBHOOK_REPLAY_WINDOW_SECS (default 300) are dropped.',
        security: [],
        parameters: [
          { name: 'x-hub-signature-256', in: 'header', required: true, schema: { type: 'string' }, description: 'HMAC-SHA256 of the raw body signed with META_APP_SECRET' },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', description: 'Meta Cloud API webhook payload' } } },
        },
        responses: {
          200: { description: 'EVENT_RECEIVED' },
          401: { description: 'Invalid HMAC signature' },
          500: { description: 'Redis unavailable — Meta will retry' },
        },
      },
    },

    // ── Bots ────────────────────────────────────────────────────────────────────
    '/admin/bots': {
      get: {
        tags: ['Bots'],
        summary: 'List bots in my org',
        description: 'Superadmin sees all bots across all orgs.',
        responses: {
          200: { description: 'Bot list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Bot' } } } } },
        },
      },
      post: {
        tags: ['Bots'],
        summary: 'Create a bot',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string' },
                  locale: { type: 'string', example: 'es-MX' },
                  systemPrompt: { type: 'string' },
                  identity: { type: 'object', description: 'Persona config (name, tone, style)' },
                  onboardingMsg: { type: 'string', description: 'First message sent to new users' },
                  historyWindow: { type: 'integer', minimum: 0, default: 5 },
                  llmProvider: { type: 'string', enum: ['openai', 'anthropic', 'google', 'mistral'] },
                  llmModel: { type: 'string' },
                  llmApiKey: { type: 'string', description: 'Stored AES-256-GCM encrypted; never returned' },
                  llmParams: { type: 'object' },
                  safetyLevel: { type: 'string', enum: ['strict', 'standard', 'minimal'], default: 'standard' },
                  webhookRateLimit: { type: 'integer', description: 'req/min, null = global default (60)' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Created bot', content: { 'application/json': { schema: { $ref: '#/components/schemas/Bot' } } } },
          400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Forbidden — insufficient role' },
        },
      },
    },
    '/admin/bots/{botId}': {
      get: {
        tags: ['Bots'],
        summary: 'Get a bot with full detail',
        description: 'Includes branding, commands, crisis config, channels, knowledge, and last 10 prompt versions.',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Bot', content: { 'application/json': { schema: { $ref: '#/components/schemas/Bot' } } } },
          403: { description: 'Forbidden' },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      put: {
        tags: ['Bots'],
        summary: 'Update bot configuration',
        description: 'Updating llmApiKey requires the bot:update-credentials permission and creates an audit log entry.',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  locale: { type: 'string' },
                  identity: { type: 'object' },
                  onboardingMsg: { type: 'string' },
                  historyWindow: { type: 'integer', minimum: 0 },
                  llmProvider: { type: 'string' },
                  llmModel: { type: 'string' },
                  llmApiKey: { type: 'string', description: 'Stored encrypted; triggers audit log entry' },
                  llmParams: { type: 'object' },
                  safetyLevel: { type: 'string', enum: ['strict', 'standard', 'minimal'] },
                  status: { type: 'string', enum: ['draft', 'active', 'paused'] },
                  webhookRateLimit: { type: 'integer', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated bot', content: { 'application/json': { schema: { $ref: '#/components/schemas/Bot' } } } },
          403: { description: 'Forbidden' },
          404: { description: 'Not found' },
        },
      },
      delete: {
        tags: ['Bots'],
        summary: 'Delete a bot and all its data',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          204: { description: 'Deleted' },
          403: { description: 'Forbidden' },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Prompt versioning ────────────────────────────────────────────────────────
    '/admin/bots/{botId}/prompt': {
      post: {
        tags: ['Bots'],
        summary: 'Update system prompt (creates a new version)',
        description: 'Appends a new BotPromptVersion row and updates the live bot.systemPrompt atomically.',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['systemPrompt'], properties: { systemPrompt: { type: 'string' } } },
            },
          },
        },
        responses: {
          200: {
            description: 'New version number',
            content: { 'application/json': { schema: { type: 'object', properties: { version: { type: 'integer' } } } } },
          },
          403: { description: 'Forbidden' },
          404: { description: 'Bot not found' },
        },
      },
    },
    '/admin/bots/{botId}/prompts': {
      get: {
        tags: ['Bots'],
        summary: 'List prompt versions (newest first)',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: {
            description: 'Prompt version history',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/PromptVersion' } } } },
          },
        },
      },
    },
    '/admin/bots/{botId}/rollback/{version}': {
      post: {
        tags: ['Bots'],
        summary: 'Roll back system prompt to a prior version',
        description: 'Applies the historical prompt as a new version (non-destructive).',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'version', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          200: {
            description: 'Rolled back',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { rolledBackTo: { type: 'string' }, newVersion: { type: 'integer' } } },
              },
            },
          },
          403: { description: 'Forbidden' },
          404: { description: 'Version not found' },
        },
      },
    },

    // ── Branding ──────────────────────────────────────────────────────────────────
    '/admin/bots/{botId}/branding': {
      get: {
        tags: ['Bots'],
        summary: 'Get bot branding',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Branding', content: { 'application/json': { schema: { $ref: '#/components/schemas/BotBranding' } } } },
          404: { description: 'No branding configured' },
        },
      },
      put: {
        tags: ['Bots'],
        summary: 'Create or update bot branding (upsert)',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  companyName: { type: 'string' },
                  logoUrl: { type: 'string' },
                  primaryColor: { type: 'string', example: '#3B82F6' },
                  website: { type: 'string' },
                  supportContact: { type: 'string' },
                  privacyPolicyUrl: { type: 'string' },
                  termsUrl: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated branding', content: { 'application/json': { schema: { $ref: '#/components/schemas/BotBranding' } } } },
          403: { description: 'Forbidden' },
        },
      },
    },

    // ── Commands ───────────────────────────────────────────────────────────────────
    '/admin/bots/{botId}/commands': {
      get: {
        tags: ['Bots'],
        summary: 'List bot commands',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: {
            description: 'Command list',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/BotCommand' } } } },
          },
        },
      },
      post: {
        tags: ['Bots'],
        summary: 'Add a command to a bot',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['trigger', 'responseType', 'payload'],
                properties: {
                  trigger: { type: 'string', example: '/help' },
                  responseType: { type: 'string', enum: ['static', 'action'] },
                  payload: { type: 'object' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Created command', content: { 'application/json': { schema: { $ref: '#/components/schemas/BotCommand' } } } },
          403: { description: 'Forbidden' },
        },
      },
    },
    '/admin/bots/{botId}/commands/{cmdId}': {
      put: {
        tags: ['Bots'],
        summary: 'Update a command',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'cmdId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  trigger: { type: 'string' },
                  responseType: { type: 'string', enum: ['static', 'action'] },
                  payload: { type: 'object' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated command', content: { 'application/json': { schema: { $ref: '#/components/schemas/BotCommand' } } } },
          403: { description: 'Forbidden' },
          404: { description: 'Command not found' },
        },
      },
      delete: {
        tags: ['Bots'],
        summary: 'Delete a command',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'cmdId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          204: { description: 'Deleted' },
          403: { description: 'Forbidden' },
          404: { description: 'Not found' },
        },
      },
    },

    // ── Crisis config ─────────────────────────────────────────────────────────────
    '/admin/bots/{botId}/crisis-config': {
      get: {
        tags: ['Bots'],
        summary: 'Get crisis helpline configuration',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: {
            description: 'Crisis configs per country',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/CrisisConfig' } } } },
          },
        },
      },
      put: {
        tags: ['Bots'],
        summary: 'Replace all crisis helpline configs for a bot',
        description: 'Atomically replaces the full set of crisis configs (deleteMany + createMany).',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['configs'],
                properties: {
                  configs: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['country', 'lines'],
                      properties: {
                        country: { type: 'string', example: 'MX' },
                        lines: {
                          type: 'array',
                          items: {
                            type: 'object',
                            required: ['name', 'phone'],
                            properties: {
                              name: { type: 'string' },
                              phone: { type: 'string' },
                              hours: { type: 'string', nullable: true },
                            },
                          },
                        },
                        enabled: { type: 'boolean', default: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Replaced',
            content: { 'application/json': { schema: { type: 'object', properties: { count: { type: 'integer' } } } } },
          },
          403: { description: 'Forbidden' },
        },
      },
    },

    // ── Channels ─────────────────────────────────────────────────────────────────
    '/admin/bots/{botId}/channels': {
      get: {
        tags: ['Channels'],
        summary: 'List channels for a bot',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: {
            description: 'Channel list',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Channel' } } } },
          },
        },
      },
      post: {
        tags: ['Channels'],
        summary: 'Add a Meta Cloud API channel to a bot',
        description: 'Credentials (accessToken, businessAccountId) are stored AES-256-GCM encrypted.',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['phoneId', 'accessToken', 'businessAccountId', 'verifyToken'],
                properties: {
                  provider: { type: 'string', default: 'meta_cloud' },
                  phoneId: { type: 'string', description: 'Meta phone_number_id' },
                  accessToken: { type: 'string', description: 'Stored encrypted; never returned' },
                  businessAccountId: { type: 'string' },
                  verifyToken: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Channel created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Channel' } } } },
          409: { description: 'Phone ID already registered to another bot', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/bots/{botId}/channels/{channelId}': {
      put: {
        tags: ['Channels'],
        summary: 'Update channel credentials or status',
        description: 'Supports token rotation (accessToken), status change, and verifyToken update.',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'channelId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  accessToken: { type: 'string', description: 'Rotates the access token (stored encrypted)' },
                  businessAccountId: { type: 'string' },
                  verifyToken: { type: 'string' },
                  status: { type: 'string', enum: ['connected', 'pending', 'error'] },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated channel', content: { 'application/json': { schema: { $ref: '#/components/schemas/Channel' } } } },
          403: { description: 'Forbidden' },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['Channels'],
        summary: 'Remove a channel from a bot',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'channelId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          204: { description: 'Deleted' },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/bots/{botId}/channels/embedded-signup': {
      post: {
        tags: ['Channels'],
        summary: 'Complete Meta Embedded Signup OAuth flow',
        description:
          'Exchanges the short-lived Meta auth code for a permanent access token, ' +
          'then creates or updates the channel record (upsert on phoneId). ' +
          'Returns 501 if META_APP_ID is not configured.',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['code', 'phoneId', 'verifyToken'],
                properties: {
                  code: { type: 'string', description: 'Meta OAuth authorization code' },
                  phoneId: { type: 'string', description: 'Meta phone_number_id' },
                  verifyToken: { type: 'string' },
                  redirectUri: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Channel created/updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Channel' } } } },
          409: { description: 'Phone ID already registered to another bot' },
          501: { description: 'META_APP_ID not configured' },
          502: { description: 'Meta token exchange failed' },
        },
      },
    },

    // ── Knowledge ─────────────────────────────────────────────────────────────────
    '/admin/bots/{botId}/knowledge': {
      get: {
        tags: ['Knowledge'],
        summary: 'List knowledge items for a bot',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: {
            description: 'Knowledge items',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/KnowledgeItem' } } } },
          },
        },
      },
      post: {
        tags: ['Knowledge'],
        summary: 'Add a knowledge item',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title', 'content'],
                properties: {
                  title: { type: 'string' },
                  content: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/KnowledgeItem' } } } },
          403: { description: 'Forbidden' },
        },
      },
    },
    '/admin/bots/{botId}/knowledge/{itemId}': {
      put: {
        tags: ['Knowledge'],
        summary: 'Update a knowledge item',
        description: 'If content changes, the stored embedding is cleared (hasEmbedding → false) until re-embedded.',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'itemId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  content: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/KnowledgeItem' } } } },
          403: { description: 'Forbidden' },
          404: { description: 'Not found' },
        },
      },
      delete: {
        tags: ['Knowledge'],
        summary: 'Delete a knowledge item',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'itemId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          204: { description: 'Deleted' },
          404: { description: 'Not found' },
        },
      },
    },
    '/admin/bots/{botId}/knowledge/upload-document': {
      post: {
        tags: ['Knowledge'],
        summary: 'Upload a supported document into the bot knowledge base',
        description:
          'Extracts readable text from pdf/docx/txt/csv/xlsx/xls, and OCR text from png/jpg/jpeg/webp using the bot provider/model already configured by the user. Splits the result into chunked knowledge items and attempts embeddings immediately when an embedding key is configured.',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: { type: 'string', format: 'binary' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Document imported',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/KnowledgeUploadResult' } } },
          },
          400: { description: 'Missing file' },
          403: { description: 'Forbidden' },
          404: { description: 'Bot not found' },
          415: { description: 'Unsupported format' },
          422: { description: 'No readable text found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/bots/{botId}/knowledge/embed': {
      post: {
        tags: ['Knowledge'],
        summary: 'Generate / refresh embeddings for all knowledge items',
        description:
          "Uses the bot's LLM API key (OpenAI text-embedding-ada-002 or equivalent). " +
          'Populates both the BYTEA column (in-process cosine fallback) and the pgvector column (ANN search, 1536-dim HNSW). ' +
          'Returns 422 when no embedding API key is configured.',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: {
            description: 'Embedding results',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    updated: { type: 'integer' },
                    failed: { type: 'integer' },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          403: { description: 'Forbidden' },
          422: { description: 'No embedding API key configured', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    // ── Integrations ───────────────────────────────────────────────────────────────
    '/admin/bots/{botId}/integrations': {
      get: {
        tags: ['Integrations'],
        summary: 'List integrations for a bot (credentials redacted)',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: {
            description: 'Integration list',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Integration' } } } },
          },
        },
      },
      post: {
        tags: ['Integrations'],
        summary: 'Add an integration to a bot',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['kind', 'provider', 'apiKey'],
                properties: {
                  kind: { type: 'string', enum: ['stt'], description: 'Integration category' },
                  provider: { type: 'string', example: 'openai' },
                  apiKey: { type: 'string', description: 'Stored AES-256-GCM encrypted; never returned' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Integration' } } } },
          403: { description: 'Forbidden' },
        },
      },
    },
    '/admin/bots/{botId}/integrations/{integrationId}': {
      put: {
        tags: ['Integrations'],
        summary: 'Update an integration (e.g. rotate API key or change status)',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'integrationId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  apiKey: { type: 'string', description: 'Rotates the API key (stored encrypted)' },
                  status: { type: 'string', enum: ['active', 'disabled'] },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Integration' } } } },
          403: { description: 'Forbidden' },
          404: { description: 'Not found' },
        },
      },
      delete: {
        tags: ['Integrations'],
        summary: 'Delete an integration',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'integrationId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          204: { description: 'Deleted' },
          404: { description: 'Not found' },
        },
      },
    },

    // ── Users (end-users) ─────────────────────────────────────────────────────────
    '/admin/bots/{botId}/users': {
      get: {
        tags: ['Users'],
        summary: 'List end-users for a bot',
        description: 'Returns metadata only — no PII. Phone numbers are never stored in plain text; only the HMAC-SHA256 hash is persisted.',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'paused', in: 'query', schema: { type: 'boolean' }, description: 'Filter by paused status' },
        ],
        responses: {
          200: {
            description: 'End-user list',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/EndUser' } } } },
          },
        },
      },
    },
    '/admin/bots/{botId}/payments': {
      get: {
        tags: ['Users'],
        summary: 'List membership payments for a bot',
        description: 'Returns payment status and membership purchase metadata without exposing provider secrets or end-user PII.',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'approved', 'rejected'] } },
          { name: 'endUserId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
        ],
        responses: {
          200: {
            description: 'Payment list',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Payment' } } } },
          },
        },
      },
    },
    '/admin/bots/{botId}/users/{userId}': {
      patch: {
        tags: ['Users'],
        summary: 'Suspend or unsuspend an end-user',
        description: 'A suspended user\'s messages are dropped before reaching the LLM. Creates an audit log entry.',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['paused'], properties: { paused: { type: 'boolean' } } },
            },
          },
        },
        responses: {
          200: {
            description: 'Updated',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { id: { type: 'string' }, paused: { type: 'boolean' } } },
              },
            },
          },
          403: { description: 'Forbidden' },
          404: { description: 'End user not found' },
        },
      },
    },
    '/admin/bots/{botId}/users/{userId}/data': {
      delete: {
        tags: ['Users'],
        summary: 'ARCO erasure — delete all end-user data (Derecho de Supresión)',
        description: 'Deletes the EndUser record and all associated messages, consents, crisis events, and feedback. LFPDPPP / GDPR compliant.',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: {
            description: 'Deleted',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { deleted: { type: 'boolean' }, userId: { type: 'string' } } },
              },
            },
          },
          403: { description: 'Forbidden' },
          404: { description: 'End user not found' },
        },
      },
    },
    '/admin/bots/{botId}/users/{userId}/export': {
      get: {
        tags: ['Users'],
        summary: 'ARCO export — return all personal data for an end-user (Derecho de Acceso)',
        description: 'Decrypts and returns message bodies alongside consents, crisis events, and feedback. Creates an audit log entry.',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: {
            description: 'Full personal data export',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    botId: { type: 'string' },
                    locale: { type: 'string', nullable: true },
                    paused: { type: 'boolean' },
                    consentDeclined: { type: 'boolean' },
                    createdAt: { type: 'string', format: 'date-time' },
                    consents: { type: 'array', items: { type: 'object', properties: { acceptedAt: { type: 'string', format: 'date-time' }, policyVersion: { type: 'string' } } } },
                    messages: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          direction: { type: 'string', enum: ['in', 'out'] },
                          inputType: { type: 'string', enum: ['text', 'voice', 'interactive'] },
                          body: { type: 'string', description: 'Decrypted message body' },
                          createdAt: { type: 'string', format: 'date-time' },
                        },
                      },
                    },
                    crisisEvents: { type: 'array', items: { $ref: '#/components/schemas/CrisisEvent' } },
                    feedback: { type: 'array', items: { $ref: '#/components/schemas/Feedback' } },
                  },
                },
              },
            },
          },
          403: { description: 'Forbidden' },
          404: { description: 'End user not found' },
        },
      },
    },
    '/admin/bots/{botId}/users/{userId}/rectify': {
      put: {
        tags: ['Users'],
        summary: 'ARCO rectify — update mutable personal data (Derecho de Rectificación)',
        description: 'Only mutable non-derived fields (locale) can be updated. Creates an audit log entry.',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', properties: { locale: { type: 'string', minLength: 2, maxLength: 10 } } },
            },
          },
        },
        responses: {
          200: {
            description: 'Rectified',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { id: { type: 'string' }, locale: { type: 'string', nullable: true } } },
              },
            },
          },
          403: { description: 'Forbidden' },
          404: { description: 'End user not found' },
        },
      },
    },
    '/admin/bots/{botId}/crisis-events': {
      get: {
        tags: ['Users'],
        summary: 'List crisis events for a bot',
        description: 'endUserId is intentionally omitted from results to prevent linking a crisis event to an identifiable user.',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        ],
        responses: {
          200: {
            description: 'Crisis events',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/CrisisEvent' } } } },
          },
        },
      },
    },
    '/admin/credential-errors': {
      get: {
        tags: ['Bots'],
        summary: 'List bots in credential_error state',
        description: 'Returns bots whose LLM API key or channel token has become invalid. Scoped to caller\'s org; superadmin sees all.',
        responses: {
          200: {
            description: 'Bots with credential errors',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', format: 'uuid' },
                      name: { type: 'string' },
                      orgId: { type: 'string', format: 'uuid' },
                      status: { type: 'string', enum: ['credential_error'] },
                      llmProvider: { type: 'string', nullable: true },
                      llmModel: { type: 'string', nullable: true },
                      updatedAt: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ── Feedback ─────────────────────────────────────────────────────────────────
    '/admin/bots/{botId}/feedback': {
      get: {
        tags: ['Feedback'],
        summary: 'List feedback entries for a bot (newest first)',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
        ],
        responses: {
          200: {
            description: 'Feedback list',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Feedback' } } } },
          },
        },
      },
    },
    '/admin/bots/{botId}/feedback/stats': {
      get: {
        tags: ['Feedback'],
        summary: 'Aggregate feedback statistics for a bot',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: {
            description: 'Feedback stats',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    count: { type: 'integer' },
                    average: { type: 'number', nullable: true, description: 'Average rating (1–5), null when count = 0' },
                    distribution: {
                      type: 'object',
                      description: 'Map from rating value to count',
                      additionalProperties: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ── Proactive ─────────────────────────────────────────────────────────────────
    '/admin/bots/{botId}/proactive': {
      post: {
        tags: ['Proactive'],
        summary: 'Send a proactive WhatsApp template message',
        description:
          'Only approved Meta message templates can be sent proactively (outside the 24-hour window). ' +
          'Rate-limited to 20 req/min.',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['to', 'templateName', 'languageCode'],
                properties: {
                  to: { type: 'string', description: 'Recipient WhatsApp phone number (E.164)', example: '+521234567890' },
                  templateName: { type: 'string', example: 'appointment_reminder' },
                  languageCode: { type: 'string', example: 'es_MX' },
                  components: { type: 'array', items: { type: 'object' }, description: 'Template variable components' },
                  channelId: { type: 'string', format: 'uuid', description: 'Specific channel to use; defaults to first connected channel' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Message sent',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    sent: { type: 'boolean' },
                    to: { type: 'string' },
                    templateName: { type: 'string' },
                  },
                },
              },
            },
          },
          403: { description: 'Forbidden' },
          404: { description: 'No connected channel found for this bot' },
        },
      },
    },

    // ── Organizations ─────────────────────────────────────────────────────────────
    '/admin/organizations': {
      get: {
        tags: ['Organizations'],
        summary: 'List organizations',
        description: 'Superadmin sees all; owner role sees own org only.',
        responses: {
          200: {
            description: 'Org list',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Organization' } } } },
          },
        },
      },
      post: {
        tags: ['Organizations'],
        summary: 'Create an organization',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string' },
                  plan: { type: 'string', enum: ['free', 'pro', 'enterprise'], default: 'free' },
                  msgQuota: { type: 'integer', minimum: 0, description: '0 = unlimited' },
                  msgRetentionDays: { type: 'integer', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Created org', content: { 'application/json': { schema: { $ref: '#/components/schemas/Organization' } } } },
        },
      },
    },
    '/admin/organizations/{id}': {
      get: {
        tags: ['Organizations'],
        summary: 'Get an organization',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Org', content: { 'application/json': { schema: { $ref: '#/components/schemas/Organization' } } } },
          404: { description: 'Not found' },
        },
      },
      put: {
        tags: ['Organizations'],
        summary: 'Update an organization (owner+)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  msgQuota: { type: 'integer', minimum: 0 },
                  msgRetentionDays: { type: 'integer', nullable: true },
                  sentryDsn: { type: 'string', description: 'Sentry DSN stored encrypted; enables per-tenant error tracking' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated org', content: { 'application/json': { schema: { $ref: '#/components/schemas/Organization' } } } },
        },
      },
      delete: {
        tags: ['Organizations'],
        summary: 'Delete an organization (superadmin only)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          204: { description: 'Deleted' },
          403: { description: 'Forbidden — superadmin required' },
        },
      },
    },
    '/admin/organizations/{id}/members': {
      get: {
        tags: ['Organizations'],
        summary: 'List members of an organization',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: {
            description: 'Member list',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/OrgMember' } } } },
          },
        },
      },
      post: {
        tags: ['Organizations'],
        summary: 'Invite a user to the organization',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'role'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  role: { type: 'string', enum: ['admin', 'editor'] },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Member added', content: { 'application/json': { schema: { $ref: '#/components/schemas/OrgMember' } } } },
          409: { description: 'Already a member' },
        },
      },
    },
    '/admin/organizations/{id}/members/{memberId}': {
      put: {
        tags: ['Organizations'],
        summary: "Change a member's role",
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'memberId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['role'],
                properties: { role: { type: 'string', enum: ['admin', 'editor'] } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Role updated' },
          403: { description: 'Cannot change own role or owner role' },
        },
      },
      delete: {
        tags: ['Organizations'],
        summary: 'Remove a member from the organization',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'memberId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          204: { description: 'Removed' },
          403: { description: 'Cannot remove self or last owner' },
        },
      },
    },
    '/admin/organizations/{id}/audit-log': {
      get: {
        tags: ['Organizations'],
        summary: 'Fetch the audit log for an organization (owner+)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'before', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Cursor for pagination (ISO 8601 datetime)' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        ],
        responses: {
          200: {
            description: 'Audit log entries',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    entries: { type: 'array', items: { $ref: '#/components/schemas/AuditLogEntry' } },
                    nextBefore: { type: 'string', format: 'date-time', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ── DLQ ──────────────────────────────────────────────────────────────────────
    '/admin/dlq': {
      get: {
        tags: ['DLQ'],
        summary: 'List DLQ jobs (newest 100, superadmin)',
        description: 'Jobs end up here after exhausting all retries on the main queue.',
        responses: {
          200: {
            description: 'DLQ jobs',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/DLQJob' } } } },
          },
          403: { description: 'Superadmin only' },
        },
      },
      delete: {
        tags: ['DLQ'],
        summary: 'Bulk purge DLQ jobs (superadmin)',
        description: 'Omit olderThanHours to drain all jobs. Specify olderThanHours to remove only jobs older than that threshold.',
        parameters: [
          { name: 'olderThanHours', in: 'query', schema: { type: 'number' }, description: 'Remove only jobs older than this many hours. Omit to purge everything.' },
        ],
        responses: {
          200: {
            description: 'Purge result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    removed: { type: 'integer' },
                    olderThanHours: { type: 'number', nullable: true },
                  },
                },
              },
            },
          },
          403: { description: 'Superadmin only' },
        },
      },
    },
    '/admin/dlq/count': {
      get: {
        tags: ['DLQ'],
        summary: 'Get DLQ depth (superadmin)',
        responses: {
          200: {
            description: 'Job count',
            content: { 'application/json': { schema: { type: 'object', properties: { count: { type: 'integer' } } } } },
          },
          403: { description: 'Superadmin only' },
        },
      },
    },
    '/admin/dlq/{jobId}/retry': {
      post: {
        tags: ['DLQ'],
        summary: 'Re-enqueue a DLQ job to the main queue (superadmin)',
        description: 'Moves the job to the main processing queue with 3 retry attempts, then removes it from the DLQ.',
        parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'Requeued',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { requeued: { type: 'boolean' }, jobId: { type: 'string' } } },
              },
            },
          },
          403: { description: 'Superadmin only' },
          404: { description: 'Job not found in DLQ' },
        },
      },
    },
    '/admin/dlq/{jobId}': {
      delete: {
        tags: ['DLQ'],
        summary: 'Permanently discard a single DLQ job (superadmin)',
        parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          204: { description: 'Discarded' },
          403: { description: 'Superadmin only' },
          404: { description: 'Job not found in DLQ' },
        },
      },
    },

    // ── Crypto (key rotation) ──────────────────────────────────────────────────────
    '/admin/crypto/reencrypt': {
      post: {
        tags: ['Crypto'],
        summary: 'Re-encrypt all credentials with the current KID (superadmin)',
        description:
          'Run this after updating ENCRYPTION_CURRENT_KID to complete a key rotation. ' +
          'Idempotent: blobs already on the current KID are skipped. ' +
          'Covers: bot LLM API keys, channel credentials, integration credentials, org Sentry DSNs. ' +
          'Does NOT cover Message.bodyEnc — use POST /admin/crypto/reencrypt-messages for that.',
        security: [{ adminKey: [] }],
        responses: {
          200: {
            description: 'Re-encryption summary',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ReencryptResult' } } },
          },
          403: { description: 'Superadmin only' },
        },
      },
    },
    '/admin/crypto/reencrypt-messages': {
      post: {
        tags: ['Crypto'],
        summary: 'Cursor-based paginated re-encryption of Message.bodyEnc (superadmin)',
        description:
          'Re-encrypts message bodies in batches. ' +
          'Call repeatedly with the returned nextCursor until done: true. ' +
          'Each call re-encrypts up to batchSize rows. Max batchSize: 500.',
        security: [{ adminKey: [] }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  cursor: { type: 'string', description: 'ID of the last processed message (from previous call)' },
                  batchSize: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Batch result',
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/ReencryptResult' },
                    {
                      type: 'object',
                      properties: {
                        nextCursor: { type: 'string', nullable: true, description: 'Pass as cursor in the next call. null when done.' },
                        done: { type: 'boolean' },
                      },
                    },
                  ],
                },
              },
            },
          },
          403: { description: 'Superadmin only' },
        },
      },
    },
  },
};
