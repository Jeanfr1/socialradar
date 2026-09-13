/** Recommendations & experiments view model. Findings (observed) and interpretations (hypotheses) stay separate. */
import { DateTime } from "luxon";
import { and, eq, inArray, max } from "drizzle-orm";
import { isValidTimezone } from "@/domain/periods";
import type { Platform } from "@/domain/types";
import { requireBrandRole, roleAtLeast } from "@/server/auth/authz";
import type { SessionUser } from "@/server/auth/session";
import type { Db } from "@/server/db/client";
import { socialAccounts, syncRuns } from "@/server/db/schema";
import { listExperiments, listRecommendations, type RecommendationFilter, type RecommendationStatus } from "@/server/insights/service";
import { RECOMMENDATION_RULES } from "@/server/insights/rules";
import { formatEvidence } from "./alerts";
import { fmtDate, fmtDateTime, fmtRelative, PLATFORM_LABEL } from "./format";

export const REC_STATUS_FILTERS = ["active", "proposed", "accepted", "in_experiment", "dismissed", "done", "all"] as const;
export const REC_PRIORITY_FILTERS = ["all", "high", "medium", "low"] as const;

const STATUS_LABEL: Record<RecommendationStatus, string> = {
  proposed: "New",
  accepted: "Accepted",
  in_experiment: "Trying",
  dismissed: "Dismissed",
  done: "Done",
  superseded: "Superseded",
};

const KIND_LABEL: Record<string, string> = {
  reconnect_account: "Reconnect account",
  publish_failures: "Publishing failures",
  queue_replenishment: "Queue replenishment",
  posting_consistency: "Posting consistency",
  format_mix: "Format mix",
  content_pillar: "Content pillar",
  tagging_gap: "Tagging gap",
  timing_experiment: "Timing experiment",
};

export interface LinkedPostVM {
  group: string;
  postId: string;
  url: string | null;
  published: string | null;
  value: string | null;
}

export interface RecommendationCardVM {
  id: string;
  kindLabel: string;
  account: string | null;
  locale: string;
  finding: string;
  interpretation: string;
  action: string;
  priority: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  successMetric: string;
  evaluationWindowDays: number;
  status: RecommendationStatus;
  statusLabel: string;
  generatedBy: string;
  updated: string;
  periodFacts: { label: string; value: string }[];
  sampleFacts: { label: string; value: string }[];
  otherFacts: { label: string; value: string }[];
  posts: LinkedPostVM[];
  experiment: { id: string; status: string; startDate: string | null; endDate: string | null } | null;
  canStartExperiment: boolean;
  defaultStart: string;
  defaultEnd: string;
  isDemo: boolean;
}

export interface ExperimentVM {
  id: string;
  hypothesis: string;
  action: string;
  successMetric: string;
  startDate: string | null;
  endDate: string | null;
  status: "planned" | "running" | "completed" | "abandoned";
  resultSummary: string | null;
  created: string;
  recommendationId: string | null;
  finished: boolean;
}

export interface RecommendationsVM {
  brand: { id: string; name: string; timezone: string; reportLocale: string; isDemo: boolean };
  canManage: boolean;
  filters: { status: (typeof REC_STATUS_FILTERS)[number]; priority: (typeof REC_PRIORITY_FILTERS)[number]; platform: Platform | "all" };
  platforms: { value: string; label: string }[];
  cards: RecommendationCardVM[];
  experiments: ExperimentVM[];
  lastGenerated: string | null;
  dataAsOf: string | null;
  emptyThreshold: string;
}

const PERIOD_RE = /window|period|from|to$|since|start|end|week/i;
const SAMPLE_RE = /sample|count|^n$|posts?$|size|total/i;

function isPostRef(v: unknown): v is { postId: string; url?: string | null; publishedAt?: string; value?: number | null } {
  return !!v && typeof v === "object" && typeof (v as { postId?: unknown }).postId === "string";
}

function splitEvidence(evidence: Record<string, unknown>, tz: string, now: Date) {
  const posts: LinkedPostVM[] = [];
  const scalars: Record<string, unknown> = {};
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}${k.charAt(0).toUpperCase()}${k.slice(1)}` : k;
      if (Array.isArray(v) && v.length > 0 && v.every(isPostRef)) {
        for (const p of v) {
          const at = p.publishedAt ? new Date(p.publishedAt) : null;
          posts.push({
            group: key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase(),
            postId: p.postId,
            url: typeof p.url === "string" && /^https?:\/\//.test(p.url) ? p.url : null,
            published: at && !Number.isNaN(at.getTime()) ? fmtDate(at, tz) : null,
            value: typeof p.value === "number" ? String(Math.round(p.value * 100) / 100) : null,
          });
        }
      } else if (isPostRef(v)) {
        posts.push({ group: key, postId: v.postId, url: typeof v.url === "string" && /^https?:\/\//.test(v.url) ? v.url : null, published: null, value: null });
      } else if (v && typeof v === "object" && !Array.isArray(v) && prefix.length < 40) {
        walk(v as Record<string, unknown>, key);
      } else {
        scalars[key] = v;
      }
    }
  };
  walk(evidence, "");
  const facts = formatEvidence(scalars, tz, now);
  const keys = Object.keys(scalars).filter((k) => !["accountId", "connectionId", "postId"].includes(k));
  const periodFacts: { label: string; value: string }[] = [];
  const sampleFacts: { label: string; value: string }[] = [];
  const otherFacts: { label: string; value: string }[] = [];
  facts.forEach((f, i) => {
    const key = keys[i] ?? "";
    if (PERIOD_RE.test(key)) periodFacts.push(f);
    else if (SAMPLE_RE.test(key)) sampleFacts.push(f);
    else otherFacts.push(f);
  });
  return { posts, periodFacts, sampleFacts, otherFacts };
}

export async function loadRecommendations(
  db: Db,
  user: SessionUser,
  brandId: string,
  now: Date,
  filters: RecommendationsVM["filters"],
): Promise<RecommendationsVM> {
  const { brand, role } = await requireBrandRole(db, user, brandId, "viewer");
  const tz = isValidTimezone(brand.timezone) ? brand.timezone : "UTC";
  const filter: RecommendationFilter = {};
  if (filters.status === "active") filter.statuses = ["proposed", "accepted", "in_experiment"];
  else if (filters.status === "all") filter.includeSuperseded = false;
  else filter.statuses = [filters.status];
  if (filters.priority !== "all") filter.priorities = [filters.priority];
  if (filters.platform !== "all") filter.platform = filters.platform;

  const [recs, experiments, allRecs, accounts] = await Promise.all([
    listRecommendations(db, user, brand.id, filter),
    listExperiments(db, user, brand.id),
    listRecommendations(db, user, brand.id, { includeSuperseded: true }),
    db
      .select({ connectionId: socialAccounts.connectionId, platform: socialAccounts.platform })
      .from(socialAccounts)
      .where(and(eq(socialAccounts.brandId, brand.id), eq(socialAccounts.mappingStatus, "mapped"))),
  ]);
  const connIds = [...new Set(accounts.map((a) => a.connectionId))];
  const [sync] = connIds.length
    ? await db
        .select({ at: max(syncRuns.finishedAt) })
        .from(syncRuns)
        .where(and(inArray(syncRuns.connectionId, connIds), eq(syncRuns.kind, "published"), inArray(syncRuns.status, ["succeeded", "partial"])))
    : [{ at: null }];
  const lastGeneratedAt = allRecs.reduce<Date | null>((m, r) => (!m || r.updatedAt > m ? r.updatedAt : m), null);
  const today = DateTime.fromJSDate(now, { zone: tz });
  const canManage = roleAtLeast(role, "manager");

  const expByRec = new Map(experiments.filter((e) => e.recommendationId).map((e) => [e.recommendationId as string, e]));
  const R = RECOMMENDATION_RULES;
  return {
    brand: { id: brand.id, name: brand.name, timezone: tz, reportLocale: brand.reportLocale, isDemo: brand.isDemo },
    canManage,
    filters,
    platforms: [...new Set(accounts.map((a) => a.platform))].map((p) => ({ value: p, label: PLATFORM_LABEL[p] })),
    cards: recs.map((r) => {
      const ev = splitEvidence(r.evidence, tz, now);
      const exp = expByRec.get(r.id);
      return {
        id: r.id,
        kindLabel: KIND_LABEL[r.kind] ?? r.kind.replace(/_/g, " "),
        account: r.handle ? `@${r.handle.replace(/^@/, "")}${r.platform ? ` (${PLATFORM_LABEL[r.platform]})` : ""}` : null,
        locale: r.locale,
        finding: r.finding,
        interpretation: r.interpretation,
        action: r.action,
        priority: r.priority,
        confidence: r.confidence,
        successMetric: r.successMetric,
        evaluationWindowDays: r.evaluationWindowDays,
        status: r.status,
        statusLabel: STATUS_LABEL[r.status],
        generatedBy: r.generatedBy,
        updated: fmtRelative(r.updatedAt, now) ?? "",
        ...ev,
        experiment: exp ? { id: exp.id, status: exp.status, startDate: exp.startDate, endDate: exp.endDate } : null,
        canStartExperiment: canManage && (r.status === "proposed" || r.status === "accepted"),
        defaultStart: today.toISODate() as string,
        defaultEnd: today.plus({ days: r.evaluationWindowDays }).toISODate() as string,
        isDemo: r.isDemo,
      };
    }),
    experiments: experiments.map((e) => ({
      id: e.id,
      hypothesis: e.hypothesis,
      action: e.action,
      successMetric: e.successMetric,
      startDate: e.startDate,
      endDate: e.endDate,
      status: e.status,
      resultSummary: e.resultSummary,
      created: fmtRelative(e.createdAt, now) ?? "",
      recommendationId: e.recommendationId,
      finished: e.status === "completed" || e.status === "abandoned",
    })),
    lastGenerated: fmtDateTime(lastGeneratedAt, tz),
    dataAsOf: fmtDateTime(sync?.at ?? null, tz),
    emptyThreshold: `at least ${R.formatMix.minPostsPerFormat} published posts per format over the last ${R.performanceWindowDays} days, observed ${R.minObservationAgeHours}h or more after publishing (timing experiments need ${R.timing.minPostsPerBucket} posts per time-of-day bucket over ${R.timingWindowDays} days)`,
  };
}
