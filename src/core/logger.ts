/** Structured logging boundary. Keeps core free of any transport concerns. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: Logger = {
  log() {
    /* no-op */
  },
};

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Emits one JSON object per line on stdout/stderr. */
export function createConsoleLogger(minimum: LogLevel = 'info'): Logger {
  const threshold = LEVEL_ORDER[minimum];
  return {
    log(level, message, fields) {
      if (LEVEL_ORDER[level] < threshold) return;
      const payload = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        message,
        ...fields,
      });
      if (level === 'error' || level === 'warn') process.stderr.write(`${payload}\n`);
      else process.stdout.write(`${payload}\n`);
    },
  };
}
