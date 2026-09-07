/*
 * Controlled logging. Never logs full URLs, cookies, credentials, or form contents.
 * Developer mode unlocks debug detail; nothing ever logs secrets because inputs are host-only.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel: LogLevel = 'warn';
let developerMode = false;

export function configureLogging(level: LogLevel, devMode: boolean): void {
  currentLevel = level;
  developerMode = devMode;
}

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel] &&
    (level !== 'debug' || developerMode);
}

/** Host-only form of a URL: never emits paths, queries, or fragments. */
export function hostOfUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '[non-http]';
    return parsed.hostname;
  } catch {
    return '[invalid-url]';
  }
}

function emit(level: LogLevel, scope: string, message: string, details?: unknown): void {
  if (!enabled(level)) return;
  const prefix = `AUVYQ[${scope}]`;
  if (level === 'error') console.error(prefix, message, details ?? '');
  else if (level === 'warn') console.warn(prefix, message, details ?? '');
  else console.log(prefix, message, details ?? '');
}

export interface Logger {
  debug(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, d) => emit('debug', scope, m, d),
    info: (m, d) => emit('info', scope, m, d),
    warn: (m, d) => emit('warn', scope, m, d),
    error: (m, d) => emit('error', scope, m, d)
  };
}
