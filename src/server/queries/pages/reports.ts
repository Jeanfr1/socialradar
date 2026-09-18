/** Weekly report history and in-app report view models (content rendered as stored; narratives already localized). */
import { DateTime } from "luxon";
import { isValidTimezone, nextReportRunAt, periodContaining, previousCompleteWeek, weekBefore, weekContaining } from "@/domain/periods";
import { NotFoundError, requireBrandRole, roleAtLeast } from "@/server/auth/authz";
import type { SessionUser } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { getReportVersion, listReportVersions } from "@/server/reports/service";
import type { WeeklyReportContent } from "@/server/reports/types";
import { redactText } from "@/server/security/redact";
import { fmtDate, fmtDateTime, fmtRelative } from "./format";
import { periodLabel } from "./workspace";

export interface ReportVersionVM {
  id: string;
  periodStart: string;
  periodEnd: string;
  weekLabel: string;
  kind: "week" | "month";
  version: number;
  trigger: "scheduled" | "manual";
  status: "generating" | "final" | "preliminary" | "failed";
  statusLabel: string;
  preliminaryReasons: string[];
  locale: string;
  generated: string | null;
  generatedRelative: string | null;
  narrativeSource: string | null;
  errorMessage: string | null;
  canDownload: boolean;
}

export interface ReportWeekVM {
  periodStart: string;
  weekLabel: string;
  latest: ReportVersionVM;
  older: ReportVersionVM[];
}

export interface ReportListVM {
  brand: { id: string; name: string; timezone: string; reportLocale: string; isDemo: boolean };
  canRegenerate: boolean;
  weeks: ReportWeekVM[];
  nextRun: string | null;
  periodOptions: { value: string; label: string }[];
  defaultPeriod: string;
}

const STATUS_LABEL: Record<ReportVersionVM["status"], string> = {
  final: "Final",
  preliminary: "Preliminar",
  failed: "Geração incompleta",
  generating: "Gerando…",
};

function toVM(r: Awaited<ReturnType<typeof listReportVersions>>[number], tz: string, now: Date): ReportVersionVM {
  const kind = r.periodKind === "month" ? "month" : "week";
  const period = periodContaining(kind, DateTime.fromISO(r.periodStart, { zone: tz }).toJSDate(), tz);
  return {
    id: r.id,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    weekLabel: periodLabel(period),
    kind,
    version: r.version,
    trigger: r.trigger,
    status: r.status,
    statusLabel: STATUS_LABEL[r.status],
    preliminaryReasons: r.preliminaryReasons,
    locale: r.locale,
    generated: fmtDateTime(r.generatedAt, tz),
    generatedRelative: fmtRelative(r.generatedAt, now),
    narrativeSource: r.narrativeSource,
    errorMessage: r.errorMessage ? redactText(r.errorMessage).slice(0, 400) : null,
    canDownload: r.status === "final" || r.status === "preliminary",
  };
}

export async function loadReportList(db: Db, user: SessionUser, brandId: string, now: Date): Promise<ReportListVM> {
  const { brand, role } = await requireBrandRole(db, user, brandId, "viewer");
  const tz = isValidTimezone(brand.timezone) ? brand.timezone : "UTC";
  const rows = await listReportVersions(db, user, brand.id);
  const weeks = new Map<string, ReportVersionVM[]>();
  for (const r of rows) weeks.set(r.periodStart, [...(weeks.get(r.periodStart) ?? []), toVM(r, tz, now)]);

  const options: { value: string; label: string }[] = [];
  let p = weekContaining(now, tz);
  for (let i = 0; i < 9; i++) {
    options.push({ value: p.start, label: `${fmtDate(p.startUtc, tz)} – ${p.end}${i === 0 ? " (in progress)" : ""}` });
    p = weekBefore(p);
  }
  return {
    brand: { id: brand.id, name: brand.name, timezone: tz, reportLocale: brand.reportLocale, isDemo: brand.isDemo },
    canRegenerate: roleAtLeast(role, "manager"),
    weeks: [...weeks.entries()].map(([periodStart, versions]) => ({
      periodStart,
      weekLabel: versions[0]!.weekLabel,
      latest: versions[0]!,
      older: versions.slice(1),
    })),
    nextRun: brand.reportSchedule.enabled ? fmtDateTime(nextReportRunAt(now, tz, brand.reportSchedule), tz) : null,
    periodOptions: options,
    defaultPeriod: previousCompleteWeek(now, tz).start,
  };
}

export interface ReportViewVM {
  brand: { id: string; name: string; timezone: string; isDemo: boolean };
  canRegenerate: boolean;
  report: ReportVersionVM & { isPreliminary: boolean; isDemo: boolean };
  content: WeeklyReportContent | null;
  versions: ReportVersionVM[];
}

export async function loadReportView(db: Db, user: SessionUser, brandId: string, reportId: string, now: Date): Promise<ReportViewVM> {
  const { brand, role } = await requireBrandRole(db, user, brandId, "viewer");
  const report = await getReportVersion(db, user, reportId);
  if (report.brandId !== brand.id) throw new NotFoundError();
  const tz = isValidTimezone(brand.timezone) ? brand.timezone : "UTC";
  const all = await listReportVersions(db, user, brand.id);
  const self = all.find((r) => r.id === report.id);
  const content = report.content && report.content.schemaVersion === 1 ? report.content : null;
  return {
    brand: { id: brand.id, name: brand.name, timezone: tz, isDemo: brand.isDemo },
    canRegenerate: roleAtLeast(role, "manager"),
    report: { ...toVM(self ?? report, tz, now), isPreliminary: report.isPreliminary, isDemo: report.isDemo },
    content,
    versions: all.filter((r) => r.periodStart === report.periodStart && r.periodKind === report.periodKind).map((r) => toVM(r, tz, now)),
  };
}
