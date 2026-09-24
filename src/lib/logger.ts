/**
 * Structured JSON-lines logger. Zero dependencies (pino-style API surface),
 * safe in Next.js server runtime and the standalone worker on Windows.
 * Secrets must never be passed in; the redact list is a last-resort guard.
 */

type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Compared lower-cased, so header-style casing ("Authorization") is caught too. */
const REDACT_KEYS = new Set([
  "password",
  "passwordHash",
  "token",
  "accessToken",
  "access_token",
  "refresh_token",
  "client_secret",
  "apiKey",
  "api_key",
  "authorization",
  "cookie",
  "encrypted",
].map((k) => k.toLowerCase()));

function isSecretKey(key: string): boolean {
  return REDACT_KEYS.has(key.toLowerCase());
}

/**
 * Bounds exist to keep a pathological object from hanging the logger — never to
 * decide where redaction stops. Anything past a bound is dropped rather than
 * passed through, because "too deep to inspect" and "safe to print" are not the
 * same thing: an earlier version returned the raw sub-tree below depth 4 and
 * happily logged a nested token in the clear.
 */
const MAX_DEPTH = 12;
const MAX_NODES = 5_000;

function redactNode(value: unknown, depth: number, seen: WeakSet<object>, budget: { nodes: number }): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[TRUNCATED: too deep]";
  if (budget.nodes++ >= MAX_NODES) return "[TRUNCATED: too large]";
  if (value instanceof Date) return value;
  if (seen.has(value)) return "[CIRCULAR]";

  // `seen` tracks the current path, not everything visited, so the same object
  // referenced twice side by side still prints both times.
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => redactNode(v, depth + 1, seen, budget));
    const out: Fields = {};
    for (const [k, v] of Object.entries(value as Fields)) {
      out[k] = isSecretKey(k) ? "[REDACTED]" : redactNode(v, depth + 1, seen, budget);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

export function redact(value: unknown): unknown {
  return redactNode(value, 0, new WeakSet<object>(), { nodes: 0 });
}

function minLevel(): number {
  const env = (process.env.LOG_LEVEL ?? "").toLowerCase() as Level;
  if (env in LEVEL_ORDER) return LEVEL_ORDER[env];
  return process.env.NODE_ENV === "production" ? LEVEL_ORDER.info : LEVEL_ORDER.debug;
}

function write(level: Level, scope: string, msg: string, fields?: Fields) {
  if (LEVEL_ORDER[level] < minLevel()) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(fields ? (redact(fields) as Fields) : {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  const file = process.env.LOG_FILE;
  if (file) {
    // fire and forget; never crash on log IO
    import("fs").then((fs) => fs.appendFile(file, line + "\n", () => undefined)).catch(() => undefined);
  }
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (msg, fields) => write("debug", scope, msg, fields),
    info: (msg, fields) => write("info", scope, msg, fields),
    warn: (msg, fields) => write("warn", scope, msg, fields),
    error: (msg, fields) => write("error", scope, msg, fields),
    child: (sub) => createLogger(`${scope}.${sub}`),
  };
}

export function errorFields(err: unknown): Fields {
  if (err instanceof Error) {
    return { error: err.message, errorName: err.name, stack: err.stack?.split("\n").slice(0, 5).join("\n") };
  }
  return { error: String(err) };
}
