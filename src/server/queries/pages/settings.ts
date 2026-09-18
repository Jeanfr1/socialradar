/** Settings view models: connections & channel mapping, brands, brand detail (members, cadence), users, system health. */
import { and, count, desc, eq, inArray, isNull, max } from "drizzle-orm";
import { listAccessibleBrands, requireBrandRole, requireWorkspaceAdmin, roleAtLeast, type BrandRole } from "@/server/auth/authz";
import type { SessionUser } from "@/server/auth/session";
import { DEFAULT_POSTING_SCHEDULE, listMembers, listUsers, REPORT_LOCALES } from "@/server/brands/service";
import { listConnections } from "@/server/connections/service";
import type { Db } from "@/server/db/client";
import { brands, connections, jobs, memberships, postingSchedules, socialAccounts, syncRuns, workerHeartbeats } from "@/server/db/schema";
import { redactText } from "@/server/security/redact";
import { fmtDateTime, fmtDateTimeShort, fmtRelative, PLATFORM_LABEL, WEEKDAY_LABEL } from "./format";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

function channelState(a: { isDisconnected: boolean; isLocked: boolean; isQueuePaused: boolean }) {
  return a.isDisconnected ? "Desconectado" : a.isLocked ? "Bloqueado" : a.isQueuePaused ? "Fila pausada" : "Ativo";
}

export function timezoneOptions(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC", "America/Sao_Paulo", "America/New_York", "Europe/Paris", "Europe/London"];
  }
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------
export interface ConnectionVM {
  id: string;
  label: string;
  status: string;
  keyHint: string | null;
  accountName: string | null;
  isDemo: boolean;
  added: string;
  lastValidated: string;
  lastSync: string;
  lastDiscovered: string;
  discoveryStale: boolean;
  lastError: string | null;
  failures: number;
  accountCount: number;
  mappedCount: number;
  rotated: string | null;
}

export interface ChannelVM {
  id: string;
  connectionId: string;
  platformLabel: string;
  handle: string;
  displayName: string | null;
  externalUrl: string | null;
  timezone: string | null;
  state: string;
  mappingStatus: "unmapped" | "mapped" | "ignored";
  brandId: string | null;
  brandName: string | null;
  canChange: boolean;
  isDemo: boolean;
  lastSeen: string;
}

export interface ConnectionsSettingsVM {
  connections: ConnectionVM[];
  channels: ChannelVM[];
  filter: "all" | "unmapped" | "mapped" | "ignored";
  counts: { all: number; unmapped: number; mapped: number; ignored: number };
  brandOptions: { id: string; name: string; isDemo: boolean }[];
}

export async function loadConnectionsSettings(db: Db, user: SessionUser, now: Date, filter: ConnectionsSettingsVM["filter"]): Promise<ConnectionsSettingsVM> {
  requireWorkspaceAdmin(user);
  const [list, accessible, discovered] = await Promise.all([
    listConnections(db, user),
    listAccessibleBrands(db, user.id),
    db
      .select({ connectionId: syncRuns.connectionId, at: max(syncRuns.finishedAt) })
      .from(syncRuns)
      .where(and(inArray(syncRuns.kind, ["queue", "discovery"]), inArray(syncRuns.status, ["succeeded", "partial"])))
      .groupBy(syncRuns.connectionId),
  ]);
  const discoveredAt = new Map(discovered.map((d) => [d.connectionId, d.at]));
  const manageable = accessible.filter((b) => roleAtLeast(b.role, "manager"));
  const brandById = new Map(accessible.map((b) => [b.id, b]));

  const rows = await db
    .select({
      id: socialAccounts.id,
      connectionId: socialAccounts.connectionId,
      platform: socialAccounts.platform,
      handle: socialAccounts.handle,
      displayName: socialAccounts.displayName,
      externalUrl: socialAccounts.externalUrl,
      providerTimezone: socialAccounts.providerTimezone,
      isQueuePaused: socialAccounts.isQueuePaused,
      isDisconnected: socialAccounts.isDisconnected,
      isLocked: socialAccounts.isLocked,
      brandId: socialAccounts.brandId,
      mappingStatus: socialAccounts.mappingStatus,
      isDemo: socialAccounts.isDemo,
      lastSeenAt: socialAccounts.lastSeenAt,
    })
    .from(socialAccounts)
    .innerJoin(connections, eq(connections.id, socialAccounts.connectionId))
    .where(and(isNull(socialAccounts.removedAt), isNull(connections.deletedAt)))
    .orderBy(socialAccounts.platform, socialAccounts.handle);

  const channels: ChannelVM[] = rows.map((r) => {
    const brand = r.brandId ? brandById.get(r.brandId) : undefined;
    return {
      id: r.id,
      connectionId: r.connectionId,
      platformLabel: PLATFORM_LABEL[r.platform],
      handle: r.handle,
      displayName: r.displayName,
      externalUrl: r.externalUrl,
      timezone: r.providerTimezone,
      state: channelState(r),
      mappingStatus: r.mappingStatus,
      brandId: r.brandId,
      brandName: r.brandId ? (brand?.name ?? "Outra marca (sem acesso)") : null,
      canChange: !r.brandId || (!!brand && roleAtLeast(brand.role, "manager")),
      isDemo: r.isDemo,
      lastSeen: fmtRelative(r.lastSeenAt, now) ?? "",
    };
  });

  return {
    connections: list.map((c) => {
      const disc = discoveredAt.get(c.id) ?? null;
      return {
        id: c.id,
        label: c.label,
        status: c.status,
        keyHint: c.keyHint,
        accountName: c.externalAccountName,
        isDemo: c.isDemo,
        added: fmtDateTime(c.createdAt, "UTC") ?? "",
        lastValidated: c.lastValidatedAt ? `${fmtRelative(c.lastValidatedAt, now)}` : "Nunca",
        lastSync: c.lastSyncSuccessAt ? `${fmtRelative(c.lastSyncSuccessAt, now)} (${fmtDateTime(c.lastSyncSuccessAt, "UTC")})` : "Nunca",
        lastDiscovered: disc ? (fmtRelative(disc, now) ?? "") : "Nunca",
        discoveryStale: !disc || now.getTime() - disc.getTime() > 24 * 3_600_000,
        lastError: c.lastErrorMessage ?? c.lastErrorCode,
        failures: c.consecutiveFailures,
        accountCount: c.accountCount,
        mappedCount: c.mappedAccountCount,
        rotated: c.rotatedAt ? fmtRelative(c.rotatedAt, now) : null,
      };
    }),
    channels: filter === "all" ? channels : channels.filter((c) => c.mappingStatus === filter),
    filter,
    counts: {
      all: channels.length,
      unmapped: channels.filter((c) => c.mappingStatus === "unmapped").length,
      mapped: channels.filter((c) => c.mappingStatus === "mapped").length,
      ignored: channels.filter((c) => c.mappingStatus === "ignored").length,
    },
    brandOptions: manageable.map((b) => ({ id: b.id, name: b.name, isDemo: b.isDemo })),
  };
}

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------
export interface BrandsSettingsVM {
  canCreate: boolean;
  brands: { id: string; name: string; role: BrandRole; isDemo: boolean; archived: boolean; timezone: string; reportLocale: string; canEdit: boolean }[];
  timezones: string[];
  locales: readonly string[];
}

export async function loadBrandsSettings(db: Db, user: SessionUser): Promise<BrandsSettingsVM> {
  const list = await listAccessibleBrands(db, user.id, { includeArchived: true });
  return {
    canCreate: user.isWorkspaceAdmin,
    brands: list.map((b) => ({
      id: b.id,
      name: b.name,
      role: b.role,
      isDemo: b.isDemo,
      archived: b.archivedAt !== null,
      timezone: b.timezone,
      reportLocale: b.reportLocale,
      canEdit: roleAtLeast(b.role, "manager"),
    })),
    timezones: timezoneOptions(),
    locales: REPORT_LOCALES,
  };
}

export interface CadenceFormVM {
  accountId: string;
  handle: string;
  platformLabel: string;
  providerTimezone: string | null;
  providerSchedule: string;
  isDefault: boolean;
  mode: string;
  timezone: string;
  days: { day: string; label: string; paused: boolean; times: string }[];
  postsPerWeek: string;
  matchMode: string;
  matchToleranceMinutes: number;
  horizonDays: number;
  warningDays: number;
  criticalDays: number;
  staleAfterMinutes: number;
}

export interface BrandSettingsVM {
  brand: {
    id: string;
    name: string;
    logoUrl: string;
    timezone: string;
    reportLocale: string;
    businessGoals: string;
    contentPillars: string;
    reportSchedule: { enabled: boolean; dayOfWeek: number; time: string };
    archived: boolean;
    isDemo: boolean;
  };
  role: BrandRole;
  isOwner: boolean;
  members: { userId: string; name: string; email: string; role: BrandRole; isActive: boolean; lastLogin: string; isSelf: boolean }[] | null;
  cadences: CadenceFormVM[];
  timezones: string[];
  locales: readonly string[];
}

export async function loadBrandSettings(db: Db, user: SessionUser, brandId: string, now: Date): Promise<BrandSettingsVM> {
  const { brand, role } = await requireBrandRole(db, user, brandId, "manager");
  const isOwner = roleAtLeast(role, "owner");
  const members = isOwner ? await listMembers(db, user, brand.id) : null;
  const rows = await db
    .select({ account: socialAccounts, schedule: postingSchedules })
    .from(socialAccounts)
    .leftJoin(postingSchedules, eq(postingSchedules.socialAccountId, socialAccounts.id))
    .where(and(eq(socialAccounts.brandId, brand.id), eq(socialAccounts.mappingStatus, "mapped"), isNull(socialAccounts.removedAt)))
    .orderBy(socialAccounts.platform, socialAccounts.handle);

  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    brand: {
      id: brand.id,
      name: brand.name,
      logoUrl: brand.logoUrl ?? "",
      timezone: brand.timezone,
      reportLocale: brand.reportLocale,
      businessGoals: brand.businessGoals ?? "",
      contentPillars: brand.contentPillars.join("\n"),
      reportSchedule: { enabled: brand.reportSchedule.enabled, dayOfWeek: brand.reportSchedule.dayOfWeek, time: `${pad(brand.reportSchedule.hour)}:${pad(brand.reportSchedule.minute)}` },
      archived: brand.archivedAt !== null,
      isDemo: brand.isDemo,
    },
    role,
    isOwner,
    members: members
      ? members.map((m) => ({ userId: m.userId, name: m.name, email: m.email, role: m.role, isActive: m.isActive, lastLogin: m.lastLoginAt ? (fmtRelative(m.lastLoginAt, now) ?? "") : "Nunca", isSelf: m.userId === user.id }))
      : null,
    cadences: rows.map(({ account, schedule }) => {
      const s = schedule ?? { ...DEFAULT_POSTING_SCHEDULE };
      return {
        accountId: account.id,
        handle: account.handle,
        platformLabel: PLATFORM_LABEL[account.platform],
        providerTimezone: account.providerTimezone,
        providerSchedule:
          (account.providerPostingSchedule ?? [])
            .map((d) => `${WEEKDAY_LABEL[d.day] ?? d.day}: ${d.paused ? "paused" : d.times.join(", ") || "none"}`)
            .join(" · ") || "Sem horários de publicação no Buffer",
        isDefault: schedule === null,
        mode: s.mode,
        timezone: s.timezone ?? "",
        days: DAYS.map((day) => {
          const entry = s.slots.find((d) => d.day === day);
          return { day, label: WEEKDAY_LABEL[day] ?? day, paused: entry?.paused ?? false, times: (entry?.times ?? []).join(", ") };
        }),
        postsPerWeek: s.postsPerWeek === null ? "" : String(s.postsPerWeek),
        matchMode: s.matchMode,
        matchToleranceMinutes: s.matchToleranceMinutes,
        horizonDays: s.horizonDays,
        warningDays: s.warningDays,
        criticalDays: s.criticalDays,
        staleAfterMinutes: s.staleAfterMinutes,
      };
    }),
    timezones: timezoneOptions(),
    locales: REPORT_LOCALES,
  };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
export interface UsersSettingsVM {
  users: { id: string; name: string; email: string; isWorkspaceAdmin: boolean; isActive: boolean; lastLogin: string; created: string; brands: string[]; isSelf: boolean }[];
}

export async function loadUsersSettings(db: Db, user: SessionUser, now: Date): Promise<UsersSettingsVM> {
  requireWorkspaceAdmin(user);
  const [list, accessible] = await Promise.all([listUsers(db, user), listAccessibleBrands(db, user.id, { includeArchived: true })]);
  const ids = accessible.map((b) => b.id);
  const rows = ids.length
    ? await db.select({ userId: memberships.userId, role: memberships.role, name: brands.name }).from(memberships).innerJoin(brands, eq(brands.id, memberships.brandId)).where(inArray(memberships.brandId, ids))
    : [];
  return {
    users: list.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      isWorkspaceAdmin: u.isWorkspaceAdmin,
      isActive: u.isActive,
      lastLogin: u.lastLoginAt ? (fmtRelative(u.lastLoginAt, now) ?? "") : "Nunca",
      created: fmtDateTime(u.createdAt, "UTC") ?? "",
      brands: rows.filter((r) => r.userId === u.id).map((r) => `${r.name} (${r.role})`),
      isSelf: u.id === user.id,
    })),
  };
}

// ---------------------------------------------------------------------------
// System health
// ---------------------------------------------------------------------------
export interface SystemHealthVM {
  workers: { id: string; started: string; lastSeen: string; online: boolean; jobsProcessed: number; lastJobKind: string | null; lastError: string | null }[];
  jobCounts: { kind: string; queued: number; running: number; succeeded: number; failed: number; dead: number }[];
  failedJobs: { id: number; kind: string; status: string; attempts: number; maxAttempts: number; lastError: string | null; updated: string }[];
  connections: {
    id: string;
    label: string;
    status: string;
    isDemo: boolean;
    lastSync: string;
    failures: number;
    windows: { name: string; remaining: number; limit: number; pct: number; resets: string }[];
    runs: { id: string; kind: string; status: string; started: string; duration: string; requests: number; items: number; error: string | null }[];
  }[];
}

export async function loadSystemHealth(db: Db, user: SessionUser, now: Date): Promise<SystemHealthVM> {
  requireWorkspaceAdmin(user);
  const [workers, counts, failed, conns, runs] = await Promise.all([
    db.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.lastSeenAt)),
    db.select({ kind: jobs.kind, status: jobs.status, n: count() }).from(jobs).groupBy(jobs.kind, jobs.status),
    db
      .select({ id: jobs.id, kind: jobs.kind, status: jobs.status, attempts: jobs.attempts, maxAttempts: jobs.maxAttempts, lastError: jobs.lastError, updatedAt: jobs.updatedAt })
      .from(jobs)
      .where(inArray(jobs.status, ["failed", "dead"]))
      .orderBy(desc(jobs.updatedAt))
      .limit(15),
    db
      .select({
        id: connections.id,
        label: connections.label,
        status: connections.status,
        isDemo: connections.isDemo,
        rateLimitState: connections.rateLimitState,
        lastSyncSuccessAt: connections.lastSyncSuccessAt,
        consecutiveFailures: connections.consecutiveFailures,
      })
      .from(connections)
      .where(isNull(connections.deletedAt)),
    db
      .select({
        id: syncRuns.id,
        connectionId: syncRuns.connectionId,
        kind: syncRuns.kind,
        status: syncRuns.status,
        startedAt: syncRuns.startedAt,
        finishedAt: syncRuns.finishedAt,
        requestsUsed: syncRuns.requestsUsed,
        itemsUpserted: syncRuns.itemsUpserted,
        errorCode: syncRuns.errorCode,
        errorMessage: syncRuns.errorMessage,
      })
      .from(syncRuns)
      .orderBy(desc(syncRuns.startedAt))
      .limit(300),
  ]);

  const kinds = [...new Set(counts.map((c) => c.kind))].sort();
  return {
    workers: workers.map((w) => ({
      id: w.workerId,
      started: fmtDateTimeShort(w.startedAt, "UTC", now) ?? "",
      lastSeen: fmtRelative(w.lastSeenAt, now) ?? "",
      online: now.getTime() - w.lastSeenAt.getTime() < 5 * 60_000,
      jobsProcessed: w.jobsProcessed,
      lastJobKind: w.lastJobKind,
      lastError: w.lastError ? redactText(w.lastError).slice(0, 300) : null,
    })),
    jobCounts: kinds.map((kind) => {
      const n = (status: string) => Number(counts.find((c) => c.kind === kind && c.status === status)?.n ?? 0);
      return { kind, queued: n("queued"), running: n("running"), succeeded: n("succeeded"), failed: n("failed"), dead: n("dead") };
    }),
    failedJobs: failed.map((j) => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      lastError: j.lastError ? redactText(j.lastError).slice(0, 300) : null,
      updated: fmtRelative(j.updatedAt, now) ?? "",
    })),
    connections: conns.map((c) => ({
      id: c.id,
      label: c.label,
      status: c.status,
      isDemo: c.isDemo,
      lastSync: c.lastSyncSuccessAt ? (fmtRelative(c.lastSyncSuccessAt, now) ?? "") : "Nunca",
      failures: c.consecutiveFailures,
      windows: Object.entries(c.rateLimitState ?? {}).map(([name, w]) => ({
        name,
        remaining: w.remaining,
        limit: w.limit,
        pct: w.limit > 0 ? Math.round((w.remaining / w.limit) * 100) : 0,
        resets: fmtRelative(new Date(w.resetAt), now) ?? w.resetAt,
      })),
      runs: runs
        .filter((r) => r.connectionId === c.id)
        .slice(0, 8)
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          started: fmtDateTimeShort(r.startedAt, "UTC", now) ?? "",
          duration: r.finishedAt ? `${Math.max(0, Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000))}s` : "running",
          requests: r.requestsUsed,
          items: r.itemsUpserted,
          error: r.errorMessage ? redactText(`${r.errorCode ? `${r.errorCode}: ` : ""}${r.errorMessage}`).slice(0, 300) : r.errorCode,
        })),
    })),
  };
}
