/**
 * Content calendar: scheduled (dueAt) and published (sentAt) posts per local day in the brand timezone, expected
 * cadence slots from coverage (covered / uncovered), gap days, unavailable lanes and items without a confirmed time.
 */
import { DateTime } from "luxon";
import { and, gte, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { isValidTimezone } from "@/domain/periods";
import { requireAccountInBrand, requireBrandRole } from "@/server/auth/authz";
import type { SessionUser } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { posts, postTags } from "@/server/db/schema";
import { logger } from "@/server/logger";
import { loadAccountStatuses } from "@/server/queries/account-status";
import type { FreshnessVM } from "@/components/ui/Freshness";
import { freshnessVM } from "./account-health";
import { dayKey, fmtDateTimeShort, fmtTime, PLATFORM_LABEL, zoneLabel } from "./format";

export type CalendarView = "month" | "week";

export interface CalendarItemVM {
  id: string;
  accountId: string;
  handle: string;
  platformLabel: string;
  statusLabel: string;
  kind: "published" | "scheduled" | "failed" | "unconfirmed" | "other";
  time: string | null;
  when: string | null;
  preview: string;
  externalUrl: string | null;
  tags: string[];
  format: string | null;
}

export interface CalendarSlotVM {
  accountId: string;
  handle: string;
  time: string;
  covered: boolean;
}

export interface CalendarCellVM {
  key: string;
  label: string;
  dayNum: number;
  inMonth: boolean;
  isToday: boolean;
  isFuture: boolean;
  items: CalendarItemVM[];
  slots: CalendarSlotVM[];
  uncovered: number;
  gap: boolean;
}

export interface CalendarLaneVM {
  accountId: string;
  handle: string;
  platformLabel: string;
  unavailable: string | null;
  cells: CalendarCellVM[];
}

export interface CalendarVM {
  brand: { id: string; name: string; timezone: string; zone: string };
  view: CalendarView;
  title: string;
  anchor: string;
  prevAnchor: string;
  nextAnchor: string;
  todayAnchor: string;
  accountFilter: string | null;
  accounts: { id: string; handle: string; platformLabel: string; unavailable: string | null }[];
  weekdays: string[];
  weeks: CalendarCellVM[][];
  lanes: CalendarLaneVM[];
  unconfirmed: CalendarItemVM[];
  freshness: FreshnessVM;
  upcomingEmpty: boolean;
  error: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  needs_approval: "Needs approval",
  scheduled: "Scheduled",
  sending: "Sending",
  sent: "Published",
  error: "Failed",
};

function localDay(d: DateTime, tz: string): DateTime {
  return DateTime.fromObject({ year: d.year, month: d.month, day: d.day }, { zone: tz });
}

export async function loadCalendar(
  db: Db,
  user: SessionUser,
  brandId: string,
  now: Date,
  opts: { view: CalendarView; anchor?: string; accountId?: string },
): Promise<CalendarVM> {
  const { brand } = await requireBrandRole(db, user, brandId, "viewer");
  if (opts.accountId) await requireAccountInBrand(db, user, opts.accountId, "viewer", { brandId: brand.id });
  const tz = isValidTimezone(brand.timezone) ? brand.timezone : "UTC";
  const today = localDay(DateTime.fromJSDate(now, { zone: tz }), tz);
  const parsed = opts.anchor ? DateTime.fromISO(opts.anchor, { zone: tz }) : null;
  const anchor = parsed && parsed.isValid && Math.abs(parsed.year - today.year) <= 5 ? localDay(parsed, tz) : today;

  let start: DateTime;
  let end: DateTime; // exclusive
  let title: string;
  let prev: DateTime;
  let next: DateTime;
  if (opts.view === "week") {
    start = localDay(anchor.minus({ days: anchor.weekday - 1 }), tz);
    end = localDay(start.plus({ days: 7 }), tz);
    title = `Week of ${start.setLocale("en-US").toFormat("d LLL yyyy")}`;
    prev = start.minus({ days: 7 });
    next = start.plus({ days: 7 });
  } else {
    const first = localDay(anchor.startOf("month"), tz);
    const last = localDay(anchor.endOf("month"), tz);
    start = localDay(first.minus({ days: first.weekday - 1 }), tz);
    end = localDay(last.plus({ days: 8 - last.weekday }), tz);
    title = first.setLocale("en-US").toFormat("LLLL yyyy");
    prev = first.minus({ months: 1 });
    next = first.plus({ months: 1 });
  }

  const allStatuses = await loadAccountStatuses(db, { brandIds: [brand.id] }, now);
  const statuses = opts.accountId ? allStatuses.filter((s) => s.account.id === opts.accountId) : allStatuses;
  const unavailableOf = (s: (typeof allStatuses)[number]) =>
    s.account.isDisconnected ? "Unavailable — disconnected" : ["invalid", "error", "revoked"].includes(s.connection.status) ? "Unavailable — connection failing" : null;
  const accountMeta = new Map(allStatuses.map((s) => [s.account.id, { handle: s.account.handle, platformLabel: PLATFORM_LABEL[s.account.platform] }]));

  const dayKeys: string[] = [];
  for (let d = start; d < end; d = localDay(d.plus({ days: 1 }), tz)) dayKeys.push(d.toISODate() as string);
  const todayKey = today.toISODate() as string;
  const monthOf = anchor.month;

  const makeCell = (key: string): CalendarCellVM => {
    const d = DateTime.fromISO(key, { zone: tz }).setLocale("en-US");
    return { key, label: d.toFormat("ccc d LLL"), dayNum: d.day, inMonth: opts.view === "week" || d.month === monthOf, isToday: key === todayKey, isFuture: key >= todayKey, items: [], slots: [], uncovered: 0, gap: false };
  };
  const cells = new Map(dayKeys.map((k) => [k, makeCell(k)]));
  const laneCells = new Map<string, Map<string, CalendarCellVM>>(statuses.map((s) => [s.account.id, new Map(dayKeys.map((k) => [k, makeCell(k)]))]));
  const unconfirmed: CalendarItemVM[] = [];
  let error: string | null = null;

  try {
    const ids = statuses.map((s) => s.account.id);
    const startUtc = start.toJSDate();
    const endUtc = end.toJSDate();
    const rows = ids.length
      ? await db
          .select({
            id: posts.id,
            socialAccountId: posts.socialAccountId,
            status: posts.status,
            dueAt: posts.dueAt,
            sentAt: posts.sentAt,
            text: posts.text,
            title: posts.title,
            externalUrl: posts.externalUrl,
            providerTags: posts.providerTags,
            format: posts.format,
          })
          .from(posts)
          .where(
            and(
              inArray(posts.socialAccountId, ids),
              ne(posts.status, "missing"),
              or(
                and(gte(posts.sentAt, startUtc), lt(posts.sentAt, endUtc)),
                and(gte(posts.dueAt, startUtc), lt(posts.dueAt, endUtc)),
                and(isNull(posts.dueAt), inArray(posts.status, ["draft", "needs_approval", "scheduled"])),
              ),
            ),
          )
          .limit(3000)
      : [];
    const tagRows = rows.length ? await db.select().from(postTags).where(inArray(postTags.postId, rows.map((r) => r.id).slice(0, 3000))) : [];
    for (const r of rows) {
      const meta = accountMeta.get(r.socialAccountId);
      const at = r.status === "sent" ? (r.sentAt ?? r.dueAt) : r.dueAt;
      const kind: CalendarItemVM["kind"] =
        r.status === "sent" ? "published" : r.status === "error" ? "failed" : r.status === "draft" || r.status === "needs_approval" || !at ? "unconfirmed" : r.status === "scheduled" ? "scheduled" : "other";
      const item: CalendarItemVM = {
        id: r.id,
        accountId: r.socialAccountId,
        handle: meta?.handle ?? "",
        platformLabel: meta?.platformLabel ?? "",
        statusLabel: STATUS_LABEL[r.status] ?? r.status,
        kind,
        time: at ? fmtTime(at, tz) : null,
        when: fmtDateTimeShort(at, tz, now),
        preview: (r.title || r.text || "").replace(/\s+/g, " ").slice(0, 160),
        externalUrl: r.externalUrl,
        tags: [...r.providerTags, ...tagRows.filter((t) => t.postId === r.id).map((t) => `${t.kind}: ${t.value}`)],
        format: r.format,
      };
      if (!at) {
        unconfirmed.push(item);
        continue;
      }
      const key = dayKey(at, tz);
      cells.get(key)?.items.push(item);
      laneCells.get(r.socialAccountId)?.get(key)?.items.push(item);
    }
  } catch (err) {
    logger.error("calendar posts failed", { err, brandId: brand.id });
    error = "We couldn't load some calendar data.";
  }

  for (const s of statuses) {
    if (unavailableOf(s)) continue;
    for (const slot of s.coverage.slots) {
      const key = dayKey(slot.at, tz);
      const vm: CalendarSlotVM = { accountId: s.account.id, handle: s.account.handle, time: fmtTime(slot.at, tz), covered: slot.covered };
      const cell = cells.get(key);
      if (cell) {
        cell.slots.push(vm);
        if (!slot.covered) cell.uncovered++;
      }
      const lane = laneCells.get(s.account.id)?.get(key);
      if (lane) {
        lane.slots.push(vm);
        if (!slot.covered) lane.uncovered++;
      }
    }
  }
  const sortCell = (c: CalendarCellVM) => {
    c.items.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
    c.slots.sort((a, b) => a.time.localeCompare(b.time));
    c.gap = c.isFuture && c.uncovered > 0;
  };
  cells.forEach(sortCell);
  laneCells.forEach((m) => m.forEach(sortCell));

  const weeks: CalendarCellVM[][] = [];
  for (let i = 0; i < dayKeys.length; i += 7) weeks.push(dayKeys.slice(i, i + 7).map((k) => cells.get(k)!));

  const nowKey = todayKey;
  const upcomingItems = [...cells.values()].filter((c) => c.key >= nowKey).flatMap((c) => c.items.filter((i) => i.kind === "scheduled" || i.kind === "unconfirmed"));
  const syncs = allStatuses.map((s) => s.lastQueueSyncAt);
  const oldest = syncs.length === 0 || syncs.some((t) => t === null) ? null : new Date(Math.min(...syncs.map((t) => (t as Date).getTime())));

  const anchorIso = (d: DateTime) => d.toISODate() as string;
  return {
    brand: { id: brand.id, name: brand.name, timezone: tz, zone: zoneLabel(now, tz) },
    view: opts.view,
    title,
    anchor: anchorIso(anchor),
    prevAnchor: anchorIso(prev),
    nextAnchor: anchorIso(next),
    todayAnchor: todayKey,
    accountFilter: opts.accountId ?? null,
    accounts: allStatuses.map((s) => ({ id: s.account.id, handle: s.account.handle, platformLabel: PLATFORM_LABEL[s.account.platform], unavailable: unavailableOf(s) })),
    weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    weeks,
    lanes: statuses.map((s) => ({
      accountId: s.account.id,
      handle: s.account.handle,
      platformLabel: PLATFORM_LABEL[s.account.platform],
      unavailable: unavailableOf(s),
      cells: dayKeys.map((k) => laneCells.get(s.account.id)!.get(k)!),
    })),
    unconfirmed,
    freshness: freshnessVM(oldest, now, tz),
    upcomingEmpty: !error && statuses.length > 0 && end.toMillis() > now.getTime() && upcomingItems.length === 0,
    error,
  };
}
