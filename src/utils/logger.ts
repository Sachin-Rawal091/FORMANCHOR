/**
 * FormPilot Logger Utility
 * Provides structured, prefixed logging for debugging across all extension contexts.
 * In production builds, debug/verbose logs can be suppressed by setting LOG_LEVEL.
 */

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_PREFIX = '[FormAnchor]';

// Default to INFO in production, DEBUG in development
const CURRENT_LEVEL: LogLevel = (() => {
  try {
    return (import.meta as any)?.env?.DEV ? 'DEBUG' : 'INFO';
  } catch {
    return 'INFO';
  }
})();

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[CURRENT_LEVEL];
}

export const logger = {
  debug: (context: string, message: string, ...data: unknown[]) => {
    if (shouldLog('DEBUG')) {
      console.debug(`${LOG_PREFIX}[${context}]`, message, ...data);
    }
  },

  info: (context: string, message: string, ...data: unknown[]) => {
    if (shouldLog('INFO')) {
      console.info(`${LOG_PREFIX}[${context}]`, message, ...data);
    }
  },

  warn: (context: string, message: string, ...data: unknown[]) => {
    if (shouldLog('WARN')) {
      console.warn(`${LOG_PREFIX}[${context}]`, message, ...data);
    }
  },

  error: (context: string, message: string, ...data: unknown[]) => {
    if (shouldLog('ERROR')) {
      console.error(`${LOG_PREFIX}[${context}]`, message, ...data);
    }
  },
};
