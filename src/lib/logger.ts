import 'server-only';

import pino, { type Logger } from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
const serviceName = process.env.LOG_SERVICE_NAME?.trim() || 'lecture-live';
const logLevel =
  process.env.LOG_LEVEL?.trim() || (isProduction ? 'info' : 'debug');

export const logger = pino({
  name: serviceName,
  level: logLevel,
  base: {
    service: serviceName,
    env: process.env.NODE_ENV ?? 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

export function getLogger(bindings?: Record<string, unknown>): Logger {
  return bindings ? logger.child(bindings) : logger;
}

export function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: 'UnknownError',
    message: String(error),
  };
}
