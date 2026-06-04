// ─── Inbound message extracted from the webhook payload ───────────────────────

export interface InboundMessage {
  phoneId: string;
  from: string;
  messageId: string;
  timestamp: number;
  type: 'text' | 'audio' | 'image' | 'interactive' | 'unknown';
  textBody?: string;
  audioId?: string;
  interactiveReply?: {
    type: 'button_reply' | 'list_reply';
    id: string;
    title: string;
  };
}

export interface ParsedWebhook {
  messages: InboundMessage[];
}

// ─── Job payload queued for the worker ────────────────────────────────────────

export interface InboundMessageJob {
  phoneId: string;
  waMessageId: string;
  from: string;
  messageType: 'text' | 'audio' | 'image' | 'interactive' | 'unknown';
  textBody?: string;
  audioId?: string;
  interactiveReply?: {
    type: 'button_reply' | 'list_reply';
    id: string;
    title: string;
  };
  timestamp: number;
  lockRetries?: number; // incremented each time the job is rescheduled due to a conversation lock
  requestId?: string;   // HTTP request ID for log correlation (webhook → queue → worker)
}

// ─── LLM provider interface ───────────────────────────────────────────────────

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMCompletionInput {
  systemPrompt: string;
  history: LLMMessage[];
  userMessage: string;
  params?: Record<string, unknown>;
  apiKey: string;
  model: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LLMCompletionOutput {
  text: string;
  usage?: TokenUsage;
}

// ─── Channel provider types ───────────────────────────────────────────────────

export interface InteractiveButton {
  id: string;
  title: string; // max 20 chars
}

export interface SendTextOptions {
  phoneId: string;
  accessToken: string;
  to: string;
  text: string;
  apiVersion: string;
}

export interface SendInteractiveOptions {
  phoneId: string;
  accessToken: string;
  to: string;
  bodyText: string;
  buttons: InteractiveButton[];
  apiVersion: string;
}

export interface SendTemplateOptions {
  phoneId: string;
  accessToken: string;
  to: string;
  templateName: string;
  languageCode: string;
  components?: unknown[];
  apiVersion: string;
}

// ─── Safety / crisis ─────────────────────────────────────────────────────────

export interface ClassificationResult {
  isCrisis: boolean;
  category?: string;
}

// ─── Channel credentials (decrypted) ─────────────────────────────────────────

export interface MetaCloudCredentials {
  accessToken: string;
  businessAccountId?: string;
}
