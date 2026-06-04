import { createHash } from 'crypto';
import type { BotCommand, BotCrisisConfig, BotKnowledge, BotIntegration } from '@prisma/client';
import { db } from '../db';
import { decrypt, decryptJson, encrypt } from '../crypto';
import { config } from '../config';
import { loadChannelByPhoneId, invalidateBotCache } from './bot.service';
import { safetyClassifier } from './safety.service';
import { notifyCredentialError } from './notification.service';
import * as consentService from './consent.service';
import { getRelevantKnowledge } from './knowledge.service';
import { tryIncrementQuota } from './quota.service';
import { downloadMedia } from './media.service';
import { getLLMProvider, LLMCredentialError, LLMRateLimitError } from '../providers/llm';
import { getChannelProvider } from '../providers/channel';
import { getTranscriber, SttCredentialError } from '../providers/stt';
import type { InboundMessageJob, LLMMessage, MetaCloudCredentials, ClassificationResult } from '../types';

const ARCO_TRIGGERS = [
  'borrar mis datos', 'eliminar mis datos', 'borrar mi historial',
  'eliminar mi historial', 'delete my data', 'delete my history',
  'arco', 'olvidame', 'olvídame',
];

// Feedback button ID prefix and sentiment map
const FB_PREFIX = 'fb_';
const FB_RATINGS: Record<string, number> = { good: 5, ok: 3, bad: 1 };

export async function processInboundMessage(job: InboundMessageJob): Promise<void> {
  // ── Step 1: Identify bot ─────────────────────────────────────────────────
  const channelWithBot = await loadChannelByPhoneId(job.phoneId);
  if (!channelWithBot) return;

  const { bot } = channelWithBot;
  const channel = channelWithBot;
  if (bot.status === 'paused') return;

  const channelCreds = decryptJson<MetaCloudCredentials>(channel.credentials);
  const channelProvider = getChannelProvider(channel.provider);

  // ── Step 3: Resolve / create end_user ───────────────────────────────────
  const phoneHash = hashPhone(job.from);
  let endUser = await db.endUser.findFirst({ where: { botId: bot.id, waPhoneHash: phoneHash } });
  if (!endUser) {
    endUser = await db.endUser.create({ data: { botId: bot.id, waPhoneHash: phoneHash, locale: bot.locale } });
  }
  if (endUser.paused) return;

  // ── Consent: interactive button replies handled first ────────────────────
  if (job.messageType === 'interactive' && job.interactiveReply) {
    await handleInteractiveReply(job, endUser, bot.id, channelProvider, channel.phoneId, channelCreds);
    return;
  }

  const hasConsent = await consentService.hasConsent(endUser.id, bot.id);
  if (!hasConsent) {
    await consentService.sendOnboarding(bot, channelProvider, channel.phoneId, channelCreds, job.from, config.META_API_VERSION);
    return;
  }

  // ── ARCO self-service erasure ────────────────────────────────────────────
  if (job.messageType === 'text' && job.textBody) {
    const normalized = job.textBody.trim().toLowerCase();
    if (ARCO_TRIGGERS.some(t => normalized === t || normalized.startsWith(t + ' ') || normalized.endsWith(' ' + t))) {
      await handleARCORequest(endUser.id, bot.id, channelProvider, channel.phoneId, channelCreds, job.from);
      return;
    }
  }

  // ── Step 4: Configured commands ──────────────────────────────────────────
  if (job.messageType === 'text' && job.textBody) {
    const command = matchCommand(bot.commands, job.textBody);
    if (command) {
      await executeCommand(command, channelProvider, channel.phoneId, channelCreds, job.from);
      return;
    }
  }

  // ── Step 5: Voice → STT ──────────────────────────────────────────────────
  let inputText = job.textBody?.trim() ?? '';

  if (job.messageType === 'audio') {
    if (!job.audioId) return;
    const sttResult = await transcribeAudio(bot.integrations, job.audioId, channelCreds.accessToken, bot.locale ?? 'es');
    if (!sttResult.ok) {
      await channelProvider.sendText({ phoneId: channel.phoneId, accessToken: channelCreds.accessToken, to: job.from, text: sttResult.errorMessage, apiVersion: config.META_API_VERSION });
      return;
    }
    inputText = sttResult.text;
  }

  if (!inputText) return;

  // ── Step 6: SafetyClassifier on INPUT — platform key, never client LLM ──
  const inputSafety = await safetyClassifier.classifyAsync(inputText);
  if (inputSafety.isCrisis) {
    await handleCrisis(bot.id, bot.crisisConfig, endUser.id, channelProvider, channel.phoneId, channelCreds, job.from, inputSafety, 'input_detected');
    return;
  }

  // ── Quota gate — atomic check+increment before any external API call ────
  const withinQuota = await tryIncrementQuota(bot.orgId).catch(() => true); // fail open
  if (!withinQuota) {
    await channelProvider.sendText({ phoneId: channel.phoneId, accessToken: channelCreds.accessToken, to: job.from, text: 'El servicio ha alcanzado su límite mensual de mensajes. Contacta al administrador.', apiVersion: config.META_API_VERSION });
    return;
  }

  // ── Step 7: History + knowledge ──────────────────────────────────────────
  const history = await getHistory(bot.id, endUser.id, bot.historyWindow);
  const embedderKey = resolveEmbedderKey(bot.integrations, bot.llmProvider ?? '', bot.llmApiKeyEnc);
  const knowledge = await getRelevantKnowledge(bot.knowledge, inputText, embedderKey);

  // ── Step 8: LLM (client's provider + client's key) ───────────────────────
  if (!bot.llmProvider || !bot.llmModel || !bot.llmApiKeyEnc) {
    await channelProvider.sendText({ phoneId: channel.phoneId, accessToken: channelCreds.accessToken, to: job.from, text: 'El servicio no está configurado aún. Intenta más tarde.', apiVersion: config.META_API_VERSION });
    return;
  }

  const llmProvider = getLLMProvider(bot.llmProvider);
  const apiKey = decrypt(bot.llmApiKeyEnc);
  const systemPrompt = buildSystemPrompt(bot.systemPrompt ?? '', knowledge, bot.branding);

  await persistMessage(bot.id, endUser.id, 'in', job.messageType === 'audio' ? 'voice' : 'text', inputText, job.waMessageId);

  let responseText: string;
  try {
    const result = await llmProvider.complete({
      systemPrompt,
      history,
      userMessage: inputText,
      params: (bot.llmParams as Record<string, unknown> | null) ?? undefined,
      apiKey,
      model: bot.llmModel,
    });
    responseText = result.text;
  } catch (err) {
    await handleLLMError(err, bot.id, bot.name, channelProvider, channel.phoneId, channelCreds, job.from);
    return;
  }

  // ── Step 9: SafetyClassifier on OUTPUT ───────────────────────────────────
  const outputSafety = safetyClassifier.classify(responseText);
  if (outputSafety.isCrisis) {
    responseText = buildCrisisMessage(bot.crisisConfig);
    await recordCrisisEvent(bot.id, endUser.id, outputSafety.category ?? 'unknown', 'output_filtered');
  }

  // ── Step 10: Persist + send ───────────────────────────────────────────────
  const outMsg = await persistMessage(bot.id, endUser.id, 'out', 'text', responseText);
  await channelProvider.sendText({ phoneId: channel.phoneId, accessToken: channelCreds.accessToken, to: job.from, text: responseText, apiVersion: config.META_API_VERSION });

  // ── Optional feedback collection ─────────────────────────────────────────
  const identity = bot.identity as Record<string, unknown> | null;
  if (identity?.collectFeedback === true && outMsg) {
    const prompt = typeof identity.feedbackPrompt === 'string' ? identity.feedbackPrompt : '¿Fue útil esta respuesta?';
    channelProvider.sendInteractive({
      phoneId: channel.phoneId,
      accessToken: channelCreds.accessToken,
      to: job.from,
      bodyText: prompt,
      buttons: [
        { id: `${FB_PREFIX}good_${outMsg.id}`, title: '👍 Útil' },
        { id: `${FB_PREFIX}ok_${outMsg.id}`, title: '🤔 Regular' },
        { id: `${FB_PREFIX}bad_${outMsg.id}`, title: '👎 No útil' },
      ],
      apiVersion: config.META_API_VERSION,
    }).catch(() => { /* non-critical */ });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashPhone(phone: string): string {
  return createHash('sha256').update(phone).digest('hex');
}

async function handleInteractiveReply(
  job: InboundMessageJob,
  endUser: { id: string },
  botId: string,
  channelProvider: ReturnType<typeof getChannelProvider>,
  phoneId: string,
  creds: MetaCloudCredentials,
): Promise<void> {
  const reply = job.interactiveReply!;

  // Feedback reply
  if (reply.id.startsWith(FB_PREFIX)) {
    await handleFeedbackReply(reply.id, endUser.id);
    return;
  }

  // Consent reply
  if (consentService.isConsentAccept(reply.id)) {
    await consentService.recordConsent(endUser.id, botId);
    await channelProvider.sendText({ phoneId, accessToken: creds.accessToken, to: job.from, text: '¡Gracias! Ya puedes escribirme.', apiVersion: config.META_API_VERSION });
  } else if (consentService.isConsentDecline(reply.id)) {
    await consentService.pauseEndUser(endUser as Parameters<typeof consentService.pauseEndUser>[0]);
    await channelProvider.sendText({ phoneId, accessToken: creds.accessToken, to: job.from, text: 'Entendido. No procesaré tus mensajes. Escríbeme de nuevo si cambias de opinión.', apiVersion: config.META_API_VERSION });
  }
}

async function handleFeedbackReply(buttonId: string, endUserId: string): Promise<void> {
  // Format: fb_{good|ok|bad}_{messageId}
  const withoutPrefix = buttonId.slice(FB_PREFIX.length);
  const underscoreIdx = withoutPrefix.indexOf('_');
  if (underscoreIdx === -1) return;
  const sentiment = withoutPrefix.slice(0, underscoreIdx);
  const messageId = withoutPrefix.slice(underscoreIdx + 1);
  const rating = FB_RATINGS[sentiment];
  if (rating === undefined || !messageId) return;
  await db.feedback.create({ data: { messageId, endUserId, rating } }).catch(() => { /* message may no longer exist */ });
}

async function handleARCORequest(
  endUserId: string,
  botId: string,
  channelProvider: ReturnType<typeof getChannelProvider>,
  phoneId: string,
  creds: MetaCloudCredentials,
  to: string,
): Promise<void> {
  await consentService.deleteEndUserData(endUserId);
  await channelProvider.sendText({
    phoneId, accessToken: creds.accessToken, to,
    text: 'Tu historial de conversación y datos han sido eliminados conforme a tu solicitud (Derecho ARCO). Si deseas continuar usando el servicio, escríbeme de nuevo.',
    apiVersion: config.META_API_VERSION,
  });
}

async function transcribeAudio(
  integrations: BotIntegration[],
  audioId: string,
  channelAccessToken: string,
  locale: string,
): Promise<{ ok: true; text: string } | { ok: false; errorMessage: string }> {
  const sttIntegration = integrations.find(i => i.kind === 'stt' && i.status === 'active');
  if (!sttIntegration) {
    return { ok: false, errorMessage: 'Los mensajes de voz no están habilitados para este servicio.' };
  }

  let sttCreds: { apiKey: string };
  try {
    sttCreds = decryptJson<{ apiKey: string }>(sttIntegration.credentials);
  } catch {
    return { ok: false, errorMessage: 'Error de configuración del servicio de voz.' };
  }

  try {
    const { buffer, mimeType } = await downloadMedia(audioId, channelAccessToken, config.META_API_VERSION);
    const transcriber = getTranscriber(sttIntegration.provider);
    const text = await transcriber.transcribe({ audioBuffer: buffer, mimeType, language: locale, apiKey: sttCreds.apiKey });
    return { ok: true, text };
  } catch (err) {
    if (err instanceof SttCredentialError) {
      return { ok: false, errorMessage: 'El servicio de voz no está disponible en este momento.' };
    }
    return { ok: false, errorMessage: 'No pude transcribir tu mensaje de voz. Por favor, escribe tu mensaje.' };
  }
}

function resolveEmbedderKey(
  integrations: BotIntegration[],
  llmProvider: string,
  llmApiKeyEnc: Buffer | null | undefined,
): string | undefined {
  // Prefer a dedicated embeddings integration
  const embInt = integrations.find(i => i.kind === 'embeddings' && i.status === 'active');
  if (embInt) {
    try {
      return decryptJson<{ apiKey: string }>(embInt.credentials).apiKey;
    } catch { /* ignore */ }
  }
  // Fall back to OpenAI LLM key (compatible with text-embedding-3-small)
  if (llmProvider === 'openai' && llmApiKeyEnc) {
    try { return decrypt(llmApiKeyEnc); } catch { /* ignore */ }
  }
  return undefined;
}

function matchCommand(commands: BotCommand[], text: string): BotCommand | undefined {
  const lower = text.trim().toLowerCase().replace(/^\//, '');
  return commands.find(c => c.trigger.toLowerCase() === lower);
}

async function executeCommand(
  command: BotCommand,
  channelProvider: ReturnType<typeof getChannelProvider>,
  phoneId: string,
  creds: MetaCloudCredentials,
  to: string,
): Promise<void> {
  if (command.responseType === 'static') {
    const payload = command.payload as { message?: string };
    if (payload.message) {
      await channelProvider.sendText({ phoneId, accessToken: creds.accessToken, to, text: payload.message, apiVersion: config.META_API_VERSION });
    }
  }
}

async function getHistory(botId: string, endUserId: string, windowSize: number): Promise<LLMMessage[]> {
  const msgs = await db.message.findMany({
    where: { botId, endUserId },
    orderBy: { createdAt: 'desc' },
    take: windowSize * 2,
  });
  return msgs.reverse().map(m => ({
    role: m.direction === 'in' ? ('user' as const) : ('assistant' as const),
    content: decrypt(m.bodyEnc),
  }));
}

function buildSystemPrompt(
  basePrompt: string,
  knowledge: string,
  branding: { companyName?: string | null; supportContact?: string | null } | null | undefined,
): string {
  let prompt = basePrompt;
  if (knowledge) prompt += `\n\n---\nBase de conocimiento relevante:\n${knowledge}\n---`;
  if (branding?.supportContact) prompt += `\n\nContacto de soporte: ${branding.supportContact}`;
  return prompt;
}

async function persistMessage(
  botId: string,
  endUserId: string,
  direction: 'in' | 'out',
  inputType: string,
  body: string,
  externalId?: string,
): Promise<{ id: string }> {
  return db.message.create({
    data: { botId, endUserId, direction, inputType, bodyEnc: encrypt(body), externalId: externalId ?? null },
    select: { id: true },
  });
}

async function handleCrisis(
  botId: string,
  crisisConfigs: BotCrisisConfig[],
  endUserId: string,
  channelProvider: ReturnType<typeof getChannelProvider>,
  phoneId: string,
  creds: MetaCloudCredentials,
  to: string,
  safety: ClassificationResult,
  actionTaken: string,
): Promise<void> {
  await recordCrisisEvent(botId, endUserId, safety.category ?? 'unknown', actionTaken);
  const message = buildCrisisMessage(crisisConfigs);
  await channelProvider.sendText({ phoneId, accessToken: creds.accessToken, to, text: message, apiVersion: config.META_API_VERSION });
}

export function buildCrisisMessage(crisisConfigs: BotCrisisConfig[]): string {
  const enabled = crisisConfigs.filter(c => c.enabled);
  if (!enabled.length) {
    return 'Parece que estás pasando por un momento difícil. Por favor, busca apoyo con alguien de confianza o llama a una línea de crisis.\n\nMéxico:\n• SAPTEL: 55 5259-8121 (24h)\n• Línea de la Vida: 800 911 2000 (24h)';
  }
  const lines = enabled.flatMap(c => {
    const l = c.lines as Array<{ name: string; phone: string; hours?: string }>;
    return l.map(line => `• ${line.name}: ${line.phone}${line.hours ? ` (${line.hours})` : ''}`);
  });
  return `Parece que estás pasando por un momento muy difícil. No estás solo/a. Por favor comunícate con:\n\n${lines.join('\n')}`;
}

async function recordCrisisEvent(botId: string, endUserId: string, category: string, actionTaken: string): Promise<void> {
  await db.crisisEvent.create({ data: { botId, endUserId, category, actionTaken } });
}

async function handleLLMError(
  err: unknown,
  botId: string,
  botName: string,
  channelProvider: ReturnType<typeof getChannelProvider>,
  phoneId: string,
  creds: MetaCloudCredentials,
  to: string,
): Promise<void> {
  if (err instanceof LLMCredentialError) {
    await db.bot.update({ where: { id: botId }, data: { status: 'credential_error' } });
    invalidateBotCache(botId);
    notifyCredentialError({ botId, botName, errorMessage: (err as Error).message, detectedAt: new Date() });
    await channelProvider.sendText({ phoneId, accessToken: creds.accessToken, to, text: 'El servicio no está disponible en este momento. Inténtalo más tarde.', apiVersion: config.META_API_VERSION });
    return;
  }
  if (err instanceof LLMRateLimitError) throw err;
  throw err;
}
