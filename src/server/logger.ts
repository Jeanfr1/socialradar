/**
 * Structured JSON logger (one line per record). Every record passes through `redact`, so secrets in messages,
 * fields or errors are masked before they are written. Level threshold comes from LOG_LEVEL
 * (debug | info | warn | error | silent; default info). Server-only.
 */
import { redact, redactText } from "@/server/security/redact";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a logger that adds `context` to every record. */
  child(context: LogFields): Logger;
}

const RANK: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

type Sink = (line: string, level: LogLevel) => void;
const defaultSink: Sink = (line, level) =>
  (level === "warn" || level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
let sink: Sink = defaultSink;

/** Test hook: capture log lines. Pass undefined to restore stdout/stderr. */
export function setLogSink(next: Sink | undefined): void {
  sink = next ?? defaultSink;
}

function threshold(): number {
  return RANK[(process.env.LOG_LEVEL ?? "info").trim().toLowerCase()] ?? 20;
}

function serialize(record: LogFields): string {
  try {
    return JSON.stringify(record, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return JSON.stringify({ ts: record.ts, level: record.level, msg: record.msg, logError: "unserializable fields" });
  }
}

export function createLogger(context: LogFields = {}): Logger {
  const safeContext = redact(context);
  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    if ((RANK[level] ?? 0) < threshold()) return;
    const head = { ts: new Date().toISOString(), level, msg: redactText(String(msg)) };
    const record = Object.assign({ ...head }, safeContext, fields ? redact(fields) : {}, head);
    try {
      sink(serialize(record), level);
    } catch {
      // Logging must never break the caller.
    }
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (extra) => createLogger({ ...context, ...extra }),
  };
}

export const logger: Logger = createLogger({ service: "brandpulse" });
