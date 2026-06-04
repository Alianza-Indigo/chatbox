import * as Sentry from '@sentry/node';

export function initSentry(dsn: string | undefined, environment: string): void {
  Sentry.init({
    dsn,
    environment,
    enabled: !!dsn && environment !== 'test',
    // Don't send PII — phone numbers and message bodies are never in exception
    // context (they're encrypted or hashed before they reach error paths).
    sendDefaultPii: false,
  });
}

export { Sentry };
