type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LEVEL: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}

// ─── In-memory log buffer (ring buffer) ───────────────────

export interface LogEntry {
  id: number;
  ts: string;
  level: LogLevel;
  msg: string;
  data?: Record<string, unknown>;
}

const LOG_BUFFER_SIZE = 1000;
const logBuffer: LogEntry[] = [];
let logCounter = 0;

// 3.25.4.3: never expose bearer credentials in stdout or the admin log buffer.
const REDACTED = '[REDACTED]';
const SENSITIVE_FIELD =
  /token|secret|credential|authorization|cookie|password|passkey|api.?key|request.?key|join.?key|save.?key|subscription|endpoint/i;

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer ' + REDACTED)
    .replace(/v1\.[A-Za-z0-9_-]{95}/g, REDACTED)
    .replace(
      /((?:[?&]|\b)(?:token|personToken|shareToken|secret|apiKey|authorization|password|requestKey|joinKey|saveKey)=)[^&#\s]+/gi,
      '$1' + REDACTED,
    )
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, REDACTED);
}

function redactValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= 8) return '[Nested]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      redactText(key),
      SENSITIVE_FIELD.test(key) ? REDACTED : redactValue(item, seen, depth + 1),
    ]),
  );
}

function bufferLog(level: LogLevel, message: string, data?: Record<string, unknown>) {
  const entry: LogEntry = {
    id: ++logCounter,
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(data ? { data } : {}),
  };

  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) {
    logBuffer.shift();
  }
}

/**
 * Get recent log entries from the in-memory buffer.
 * Supports filtering by level (minimum) and text search.
 */
export function getRecentLogs(options?: { minLevel?: LogLevel; search?: string; limit?: number; afterId?: number }): {
  entries: LogEntry[];
  latestId: number;
} {
  const { minLevel, search, limit = 200, afterId } = options ?? {};

  let entries = logBuffer;

  if (afterId) {
    entries = entries.filter((e) => e.id > afterId);
  }

  if (minLevel) {
    const minOrder = LEVEL_ORDER[minLevel];
    entries = entries.filter((e) => LEVEL_ORDER[e.level] >= minOrder);
  }

  if (search) {
    const lower = search.toLowerCase();
    entries = entries.filter(
      (e) => e.msg.toLowerCase().includes(lower) || (e.data && JSON.stringify(e.data).toLowerCase().includes(lower)),
    );
  }

  // Return the most recent entries (tail)
  const result = entries.slice(-limit);

  return {
    entries: result,
    latestId: logCounter,
  };
}

// ─── Core log function ────────────────────────────────────

function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
  if (!shouldLog(level)) return;

  const safeMessage = redactText(message);
  const safeData = data ? (redactValue(data) as Record<string, unknown>) : undefined;
  // The admin ring buffer and stdout receive the same redacted snapshot.
  bufferLog(level, safeMessage, safeData);

  const entry = {
    ...safeData,
    ts: new Date().toISOString(),
    level,
    msg: safeMessage,
  };

  const line = JSON.stringify(entry);

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log('error', msg, data),
};
