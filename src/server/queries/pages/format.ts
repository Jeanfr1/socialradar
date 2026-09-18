/**
 * Display formatting for page view models. All instants are stored in UTC and rendered in an explicit IANA zone
 * with a zone label. Server-only helpers (pure; `now` is injected).
 */
import { DateTime } from "luxon";
import type { Platform } from "@/domain/types";

const SAFE_TZ = (tz: string) => (DateTime.local().setZone(tz).isValid ? tz : "UTC");

function dt(at: Date, tz: string): DateTime {
  return DateTime.fromJSDate(at, { zone: SAFE_TZ(tz) }).setLocale("pt-BR");
}

/** Short zone label such as "GMT-3" or "EDT". */
export function zoneLabel(at: Date, tz: string): string {
  return dt(at, tz).toFormat("ZZZZ");
}

/** "Tue 16 Sep 2026, 20:00 GMT-3" */
export function fmtDateTime(at: Date | null | undefined, tz: string): string | null {
  if (!at) return null;
  const d = dt(at, tz);
  return `${d.toFormat("ccc d LLL yyyy, HH:mm")} ${d.toFormat("ZZZZ")}`;
}

/** "Tue 16 Sep, 20:00 GMT-3" (current year omitted). */
export function fmtDateTimeShort(at: Date | null | undefined, tz: string, now?: Date): string | null {
  if (!at) return null;
  const d = dt(at, tz);
  const sameYear = !now || dt(now, tz).year === d.year;
  return `${d.toFormat(sameYear ? "ccc d LLL, HH:mm" : "ccc d LLL yyyy, HH:mm")} ${d.toFormat("ZZZZ")}`;
}

/** "Tue 16 Sep 2026" */
export function fmtDate(at: Date | null | undefined, tz: string): string | null {
  if (!at) return null;
  return dt(at, tz).toFormat("ccc d LLL yyyy");
}

export function fmtTime(at: Date, tz: string): string {
  return dt(at, tz).toFormat("HH:mm");
}

/** Local calendar date key (YYYY-MM-DD) in a zone. */
export function dayKey(at: Date, tz: string): string {
  return dt(at, tz).toISODate() as string;
}

/** Relative time: "agora", "há 42 min", "há 5 h", "há 3 d", "em 2 d". */
export function fmtRelative(at: Date | null | undefined, now: Date): string | null {
  if (!at) return null;
  const diffMs = now.getTime() - at.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const min = Math.round(abs / 60_000);
  let text: string;
  if (min < 1) return future ? "em menos de um minuto" : "agora";
  if (min < 60) text = `${min} min`;
  else if (min < 48 * 60) text = `${Math.round(min / 60)} h`;
  else text = `${Math.round(min / 1440)} d`;
  return future ? `em ${text}` : `há ${text}`;
}

export function fmtSynced(at: Date | null | undefined, now: Date): string {
  const rel = fmtRelative(at, now);
  return rel ? `Sincronizado ${rel}` : "Nunca sincronizado";
}

export function hoursSince(at: Date | null | undefined, now: Date): number | null {
  return at ? (now.getTime() - at.getTime()) / 3_600_000 : null;
}

const NUM = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const INT = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "Indisponível";
  return Math.abs(n) >= 100 ? INT.format(n) : NUM.format(n);
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "Indisponível";
  return `${n.toFixed(digits)}%`;
}

export function fmtSignedPct(n: number, digits = 1): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function fmtDays(n: number | null | undefined): string | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const r = Math.round(n * 10) / 10;
  return `${r} ${r === 1 ? "dia" : "dias"}`;
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

export const PLATFORM_LABEL: Record<Platform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  other: "Other",
};

export const WEEKDAY_LABEL: Record<string, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

export function iso(at: Date | null | undefined): string | null {
  return at ? at.toISOString() : null;
}
