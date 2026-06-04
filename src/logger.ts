import pino from 'pino';

export const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  // Never include message body content in logs
  serializers: { err: pino.stdSerializers.err },
});
