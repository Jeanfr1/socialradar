import { describe, expect, it } from "vitest";
import { evaluateAccountAlerts, evaluateConnectionAlerts, resolveMissing, type AccountAlertInput } from "./alert-rules";
import { computeCoverage } from "./coverage";
import type { CadenceConfig, CoverageInput, QueueItem, Weekday } from "./types";

const ALL_DAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const NOW = new Date("2026-09-14T12:00:00Z"); // Mon 09:00 São Paulo
const slot = (d: number) => new Date(Date.UTC(2026, 8, 14 + d, 23, 0)); // 20:00 São Paulo

function cadence(overrides: Partial<CadenceConfig> = {}): CadenceConfig {
  return {
    mode: "custom",
    timezone: "America/Sao_Paulo",
    days: ALL_DAYS.map((day) => ({ day, paused: false, times: ["20:00"] })),
    postsPerWeek: null,
    matchMode: "same_day",
    matchToleranceMinutes: 90,
    horizonDays: 7,
    warningDays: 7,
    criticalDays: 3,
    staleAfterMinutes: 360,
    ...overrides,
  };
}

function coverage(items: QueueItem[], overrides: Partial<CoverageInput> = {}, cap?: number) {
  return computeCoverage(
    { now: NOW, cadence: cadence(), items, lastQueueSyncAt: NOW, queuePaused: false, accountDisconnected: false, ...overrides },
    { inventoryCap: cap ?? null },
  );
}

function account(overrides: Partial<AccountAlertInput> = {}): AccountAlertInput {
  return {
    accountId: "acc1",
    brandId: "brand1",
    handle: "brand_tiktok",
    platform: "tiktok",
    coverage: coverage([]),
    recentErrors: [],
    overdue: [],
    isDisconnected: false,
    isQueuePaused: false,
    now: NOW,
    timezone: "America/Sao_Paulo",
    lastQueueSyncAt: NOW,
    ...overrides,
  };
}

const types = (alerts: { type: string }[]) => alerts.map((a) => a.type).sort();

describe("evaluateAccountAlerts — queue coverage", () => {
  it("empty queue → queue_empty critical with a concrete, dated action", () => {
    const [alert, ...rest] = evaluateAccountAlerts(account());
    expect(rest).toHaveLength(0);
    expect(alert).toMatchObject({
      type: "queue_empty",
      severity: "critical",
      dedupeKey: "queue_coverage:acc1",
      brandId: "brand1",
      socialAccountId: "acc1",
      title: "Nenhum post agendado em @brand_tiktok (TikTok)",
      suggestedAction: "Agende 7 posts até seg. 14 set. 20:00 (America/Sao_Paulo) para cobrir os próximos 7 dias.",
    });
    expect(alert!.evidence).toMatchObject({ scheduledCount: 0, postsNeeded: 7, firstUncoveredSlot: "2026-09-14T23:00:00.000Z" });
  });

  it("warning → critical → empty keep the same dedupe key (updated in place)", () => {
    const warning = evaluateAccountAlerts(account({ coverage: coverage([0, 1, 2, 3].map((d) => ({ id: `p${d}`, dueAt: slot(d), status: "scheduled" as const }))) }));
    const critical = evaluateAccountAlerts(account({ coverage: coverage([{ id: "p0", dueAt: slot(0), status: "scheduled" }]) }));
    const empty = evaluateAccountAlerts(account());
    expect(warning[0]).toMatchObject({ type: "queue_coverage", severity: "warning", title: "A fila de @brand_tiktok (TikTok) cobre apenas 4.5 dias" });
    expect(warning[0]!.suggestedAction).toBe("Agende 3 posts até sex. 18 set. 20:00 (America/Sao_Paulo) para cobrir os próximos 7 dias.");
    expect(critical[0]).toMatchObject({ type: "queue_coverage", severity: "critical" });
    expect(new Set([warning[0]!.dedupeKey, critical[0]!.dedupeKey, empty[0]!.dedupeKey])).toEqual(new Set(["queue_coverage:acc1"]));
  });

  it("never suggests scheduling 0 posts when a short horizon is fully covered", () => {
    const items = Array.from({ length: 5 }, (_, d) => ({ id: `p${d}`, dueAt: slot(d), status: "scheduled" as const }));
    const cov = computeCoverage({ now: NOW, cadence: cadence({ horizonDays: 5 }), items, lastQueueSyncAt: NOW, queuePaused: false, accountDisconnected: false });
    const [alert] = evaluateAccountAlerts(account({ coverage: cov }));
    expect(alert!.severity).toBe("warning");
    expect(alert!.suggestedAction).not.toMatch(/Agende 0/);
    expect(alert!.suggestedAction).toContain("Aumente o horizonte");
  });

  it("healthy fresh account produces no alerts", () => {
    const items = Array.from({ length: 7 }, (_, d) => ({ id: `p${d}`, dueAt: slot(d), status: "scheduled" as const }));
    expect(evaluateAccountAlerts(account({ coverage: coverage(items) }))).toEqual([]);
  });

  it("respects the provider inventory cap in the suggested action", () => {
    const twice = cadence({ horizonDays: 14, days: ALL_DAYS.map((day) => ({ day, paused: false, times: ["18:28", "20:30"] })) });
    const items = computeCoverage({ now: NOW, cadence: twice, items: [], lastQueueSyncAt: NOW, queuePaused: false, accountDisconnected: false })
      .slots.slice(0, 4)
      .map((s, i) => ({ id: `p${i}`, dueAt: s.at, status: "scheduled" as const }));
    const cov = computeCoverage({ now: NOW, cadence: twice, items, lastQueueSyncAt: NOW, queuePaused: false, accountDisconnected: false }, { inventoryCap: 10 });
    const [alert] = evaluateAccountAlerts(account({ coverage: cov, inventoryCap: 10 }));
    expect(alert!.severity).toBe("critical");
    expect(alert!.suggestedAction).toBe(
      "Agende 6 posts até qua. 16 set. 18:28 (America/Sao_Paulo) (o limite de 10 posts agendados do provedor impede cobrir todos os 14 dias) e reabasteça a fila conforme os posts forem publicados.",
    );

    const full = computeCoverage(
      { now: NOW, cadence: twice, items: cov.slots.slice(0, 10).map((s, i) => ({ id: `f${i}`, dueAt: s.at, status: "scheduled" as const })), lastQueueSyncAt: NOW, queuePaused: false, accountDisconnected: false },
      { inventoryCap: 10 },
    );
    const [capped] = evaluateAccountAlerts(account({ coverage: full }));
    expect(capped!.suggestedAction).toMatch(/^O limite de posts agendados do provedor \(10\) foi atingido/);
  });
});

describe("evaluateAccountAlerts — freshness and account state suppress queue alerts", () => {
  it("stale sync → sync_stale only, never queue_empty", () => {
    const lastSync = new Date(NOW.getTime() - 8 * 3_600_000);
    const alerts = evaluateAccountAlerts(account({ coverage: coverage([], { lastQueueSyncAt: lastSync }), lastQueueSyncAt: lastSync }));
    expect(types(alerts)).toEqual(["sync_stale"]);
    expect(alerts[0]).toMatchObject({ severity: "warning", dedupeKey: "sync_stale:acc1" });
    expect(alerts[0]!.evidence).toMatchObject({ freshness: "stale", lastQueueSyncAt: lastSync.toISOString(), lastKnownQueueState: "empty" });
  });

  it("never synced → informational sync_stale", () => {
    const alerts = evaluateAccountAlerts(account({ coverage: coverage([], { lastQueueSyncAt: null }), lastQueueSyncAt: null }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: "sync_stale", severity: "info" });
  });

  it("disconnected → account_disconnected (no queue or stale alerts); overdue posts downgraded with likely cause", () => {
    const lastSync = new Date(NOW.getTime() - 48 * 3_600_000);
    const alerts = evaluateAccountAlerts(
      account({
        isDisconnected: true,
        coverage: coverage([], { accountDisconnected: true, lastQueueSyncAt: lastSync }),
        overdue: [{ postId: "late1", dueAt: new Date(NOW.getTime() - 3_600_000) }],
      }),
    );
    expect(types(alerts)).toEqual(["account_disconnected", "post_overdue"]);
    const overdue = alerts.find((a) => a.type === "post_overdue")!;
    expect(overdue.severity).toBe("info");
    expect(overdue.evidence.likelyCause).toBe("account_disconnected");
  });

  it("paused queue → queue_paused, no coverage alert", () => {
    const alerts = evaluateAccountAlerts(account({ isQueuePaused: true, coverage: coverage([], { queuePaused: true }) }));
    expect(types(alerts)).toEqual(["queue_paused"]);
    expect(alerts[0]).toMatchObject({ severity: "warning", dedupeKey: "queue_paused:acc1" });
  });

  it("unresolved times → info alert alongside coverage", () => {
    const cov = coverage([{ id: "d", dueAt: null, status: "draft" }, { id: "n", dueAt: slot(1), status: "needs_approval" }]);
    const alerts = evaluateAccountAlerts(account({ coverage: cov }));
    expect(types(alerts)).toEqual(["queue_empty", "unresolved_times"]);
    expect(alerts.find((a) => a.type === "unresolved_times")).toMatchObject({
      severity: "info",
      title: "2 posts pendentes de @brand_tiktok (TikTok) sem horário de publicação confirmado",
    });
  });
});

describe("evaluateAccountAlerts — publishing problems", () => {
  const healthy = coverage(Array.from({ length: 7 }, (_, d) => ({ id: `p${d}`, dueAt: slot(d), status: "scheduled" as const })));

  it("publish_failed dedupes per post; severity by recency; provider text truncated", () => {
    const alerts = evaluateAccountAlerts(
      account({
        coverage: healthy,
        recentErrors: [
          { postId: "e1", dueAt: new Date(NOW.getTime() - 2 * 3_600_000), message: "x".repeat(2000) },
          { postId: "e1", dueAt: new Date(NOW.getTime() - 2 * 3_600_000), message: "duplicate row" },
          { postId: "e2", dueAt: new Date(NOW.getTime() - 72 * 3_600_000), message: "Media too large" },
        ],
      }),
    );
    expect(alerts.map((a) => a.dedupeKey)).toEqual(["publish_failed:e1", "publish_failed:e2"]);
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[1]!.severity).toBe("warning");
    expect((alerts[0]!.evidence.providerMessage as string).length).toBe(500);
    expect(alerts[1]!.suggestedAction).toContain("sex. 11 set. 09:00 (America/Sao_Paulo)");
  });

  it("post_overdue aggregates per account and excludes posts already reported as failed", () => {
    const alerts = evaluateAccountAlerts(
      account({
        coverage: healthy,
        recentErrors: [{ postId: "e1", dueAt: new Date(NOW.getTime() - 3_600_000), message: "boom" }],
        overdue: [
          { postId: "o2", dueAt: new Date("2026-09-14T11:00:00Z") },
          { postId: "e1", dueAt: new Date(NOW.getTime() - 3_600_000) },
          { postId: "o1", dueAt: new Date("2026-09-14T10:00:00Z") },
        ],
      }),
    );
    const overdue = alerts.find((a) => a.type === "post_overdue")!;
    expect(overdue).toMatchObject({ dedupeKey: "post_overdue:acc1", severity: "warning", title: "2 posts agendados atrasados em @brand_tiktok (TikTok)" });
    expect(overdue.evidence).toMatchObject({ postIds: ["o1", "o2"], oldestDueAt: "2026-09-14T10:00:00.000Z", likelyCause: null });
  });

  it("accepts a custom date formatter", () => {
    const [alert] = evaluateAccountAlerts(account({ formatDate: (d) => d.toISOString() }));
    expect(alert!.suggestedAction).toBe("Agende 7 posts até 2026-09-14T23:00:00.000Z para cobrir os próximos 7 dias.");
  });
});

describe("evaluateConnectionAlerts", () => {
  const base = {
    connectionId: "c1",
    status: "active",
    lastSyncSuccessAt: new Date(NOW.getTime() - 30 * 60_000),
    consecutiveFailures: 0,
    lastErrorCode: null,
    now: NOW,
    staleAfterMinutes: 360,
  };

  it("healthy or pending connection → no alerts; transient failures below threshold → none", () => {
    expect(evaluateConnectionAlerts(base)).toEqual([]);
    expect(evaluateConnectionAlerts({ ...base, status: "pending", lastSyncSuccessAt: null })).toEqual([]);
    expect(evaluateConnectionAlerts({ ...base, consecutiveFailures: 2, lastErrorCode: "upstream" })).toEqual([]);
  });

  it("credential problems are critical", () => {
    for (const input of [{ ...base, status: "invalid" }, { ...base, status: "revoked" }, { ...base, lastErrorCode: "unauthorized", consecutiveFailures: 1 }]) {
      const [a] = evaluateConnectionAlerts(input);
      expect(a).toMatchObject({ type: "connection_failing", severity: "critical", dedupeKey: "connection_failing:c1", connectionId: "c1" });
    }
  });

  it("repeated failures escalate; throttling stays a warning; failing suppresses sync_stale", () => {
    const stale = new Date(NOW.getTime() - 48 * 3_600_000);
    expect(evaluateConnectionAlerts({ ...base, consecutiveFailures: 3, lastErrorCode: "upstream" })[0]!.severity).toBe("warning");
    const six = evaluateConnectionAlerts({ ...base, consecutiveFailures: 6, lastErrorCode: "network", lastSyncSuccessAt: stale });
    expect(six).toHaveLength(1);
    expect(six[0]!.severity).toBe("critical");
    const throttled = evaluateConnectionAlerts({ ...base, consecutiveFailures: 8, lastErrorCode: "rate_limited" });
    expect(throttled[0]).toMatchObject({ severity: "warning", title: "Sincronização do Buffer limitada 8 vezes seguidas" });
  });

  it("stale connection without failures → sync_stale scoped to the connection", () => {
    const warn = evaluateConnectionAlerts({ ...base, lastSyncSuccessAt: new Date(NOW.getTime() - 7 * 3_600_000) });
    expect(warn[0]).toMatchObject({ type: "sync_stale", severity: "warning", dedupeKey: "sync_stale:connection:c1" });
    expect(evaluateConnectionAlerts({ ...base, lastSyncSuccessAt: new Date(NOW.getTime() - 25 * 3_600_000) })[0]!.severity).toBe("critical");
    expect(evaluateConnectionAlerts({ ...base, lastSyncSuccessAt: null })[0]!.title).toBe("A conexão com o Buffer nunca sincronizou com sucesso");
  });
});

describe("resolveMissing", () => {
  it("returns open keys without a current candidate, unique and in order", () => {
    const candidates = evaluateAccountAlerts(account());
    expect(resolveMissing(["sync_stale:acc1", "queue_coverage:acc1", "publish_failed:e9", "sync_stale:acc1"], candidates)).toEqual([
      "sync_stale:acc1",
      "publish_failed:e9",
    ]);
    expect(resolveMissing([], candidates)).toEqual([]);
  });
});
