// Callers must NOT include credentials, message content, or PII.

import { config } from '../config';
import { logger } from '../logger';

interface AlertPayload {
  event: string;
  [key: string]: unknown;
}

// Fire-and-forget delivery to WEBHOOK_ALERT_URL (Slack/Make.com/Zapier compatible).
// Structured logging serves as fallback when no URL is configured.
function sendWebhookAlert(payload: AlertPayload): void {
  const url = config.WEBHOOK_ALERT_URL;

  logger.error(payload, `alert:${payload.event}`);

  if (!url) return;

  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, timestamp: new Date().toISOString() }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {
    // Delivery failure is non-fatal — structured log above always fires
  });
}

export interface CredentialErrorEvent {
  botId: string;
  botName: string;
  errorMessage: string;
  detectedAt: Date;
}

export function notifyCredentialError(event: CredentialErrorEvent): void {
  sendWebhookAlert({
    event: 'credential_error',
    botId: event.botId,
    botName: event.botName,
    // Truncate to avoid leaking any embedded key fragment from error messages
    error: event.errorMessage.slice(0, 120),
    detectedAt: event.detectedAt.toISOString(),
  });
}

export function notifyBotRestored(botId: string, botName: string): void {
  logger.info({ botId, botName }, 'alert:bot_restored');
}

export function notifyDLQAlert(jobId: string, phoneId: string): void {
  sendWebhookAlert({
    event: 'dlq_job_added',
    jobId,
    phoneId, // Meta phone number ID — not end-user phone
  });
}

export function notifyLLMFailure(botId: string, botName: string, errorMessage: string): void {
  sendWebhookAlert({
    event: 'llm_failure',
    botId,
    botName,
    error: errorMessage.slice(0, 120),
  });
}
