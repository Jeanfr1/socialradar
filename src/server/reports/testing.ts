/** Test-only seeding helpers for report and insight tests (PGlite). Never imported by runtime code. */
import type { MetricKey } from "@/domain/types";
import type { BrandRole } from "@/server/auth/authz";
import type { Db } from "@/server/db/client";
import { brands, connections, memberships, metricObservations, postingSchedules, postMetricsLatest, posts, postTags, socialAccounts, syncRuns, users } from "@/server/db/schema";

export const FAKE_CIPHERTEXT = "v1:1:FAKECIPHERTEXT-7Qz9-DO-NOT-LEAK-a8f3b2c1d0";
export const FAKE_CONNECTION_LABEL = "Agency key SECRET-LABEL-4c2e";
const HOUR = 3_600_000;
let seq = 0;
const uniq = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

export async function seedUser(db: Db, name = "User"): Promise<{ id: string; isWorkspaceAdmin: boolean }> {
  const [u] = await db.insert(users).values({ email: `${name.toLowerCase().replace(/\W+/g, "")}-${uniq()}@example.test`, name, passwordHash: "x" }).returning();
  return { id: u!.id, isWorkspaceAdmin: false };
}

export async function seedBrand(db: Db, opts: { name?: string; locale?: string; timezone?: string; contentPillars?: string[]; isDemo?: boolean } = {}) {
  const [b] = await db
    .insert(brands)
    .values({ name: opts.name ?? "Marca", slug: `marca-${uniq()}`, reportLocale: opts.locale ?? "pt-BR", timezone: opts.timezone ?? "America/Sao_Paulo", contentPillars: opts.contentPillars ?? [], isDemo: opts.isDemo ?? false })
    .returning();
  return b!;
}

export async function addMember(db: Db, userId: string, brandId: string, role: BrandRole) {
  await db.insert(memberships).values({ userId, brandId, role });
}

export async function seedConnection(db: Db): Promise<string> {
  const [c] = await db
    .insert(connections)
    .values({ provider: "buffer", label: FAKE_CONNECTION_LABEL, status: "active", credentialCiphertext: FAKE_CIPHERTEXT, credentialKeyVersion: 1, credentialFingerprint: uniq().slice(0, 12) })
    .returning();
  return c!.id;
}

export async function seedAccount(
  db: Db,
  opts: { connectionId: string; brandId: string | null; platform?: "instagram" | "tiktok" | "youtube"; handle?: string; dailySlot?: string | null; isDisconnected?: boolean },
): Promise<string> {
  const [a] = await db
    .insert(socialAccounts)
    .values({
      connectionId: opts.connectionId,
      provider: "buffer",
      externalChannelId: `ch-${uniq()}`,
      platform: opts.platform ?? "instagram",
      platformAccountId: uniq(),
      handle: opts.handle ?? "marca_ig",
      brandId: opts.brandId,
      mappingStatus: opts.brandId ? "mapped" : "unmapped",
      providerTimezone: "America/Sao_Paulo",
      isDisconnected: opts.isDisconnected ?? false,
    })
    .returning();
  if (opts.dailySlot) {
    await db.insert(postingSchedules).values({
      socialAccountId: a!.id,
      mode: "custom",
      timezone: "America/Sao_Paulo",
      slots: (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((day) => ({ day, paused: false, times: [opts.dailySlot as string] })),
    });
  }
  return a!.id;
}

export async function seedSync(db: Db, connectionId: string, kind: "queue" | "published", finishedAt: Date, status: "succeeded" | "failed" = "succeeded") {
  await db.insert(syncRuns).values({ connectionId, kind, status, startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt });
}

export interface SeedPostInput {
  accountId: string;
  publishedAt: Date;
  format?: string | null;
  status?: "sent" | "error" | "scheduled";
  text?: string | null;
  errorMessage?: string | null;
  metricsUpdatedAt?: Date | null;
  latest?: Partial<Record<MetricKey, number>>;
  /** Observation history: provider refreshes at the given post ages. */
  history?: { ageHours: number; values: Partial<Record<MetricKey, number>> }[];
  tags?: { kind: "pillar" | "topic" | "format" | "campaign"; value: string }[];
}

export async function seedPost(db: Db, input: SeedPostInput): Promise<string> {
  const status = input.status ?? "sent";
  const [p] = await db
    .insert(posts)
    .values({
      socialAccountId: input.accountId,
      provider: "buffer",
      externalPostId: `post-${uniq()}`,
      status,
      dueAt: input.publishedAt,
      sentAt: status === "sent" ? input.publishedAt : null,
      format: input.format === undefined ? "reel" : input.format,
      text: input.text ?? null,
      errorMessage: input.errorMessage ?? null,
      externalUrl: `https://social.example/p/${uniq()}`,
      metricsUpdatedAt: input.metricsUpdatedAt ?? null,
    })
    .returning();
  const postId = p!.id;
  const row = (metricKey: string, value: number, providerUpdatedAt: Date) => ({
    subject: "post" as const,
    postId,
    socialAccountId: input.accountId,
    metricKey,
    value,
    valueStatus: value === 0 ? ("reported_zero" as const) : ("reported" as const),
    unit: "count",
    semantics: "lifetime_cumulative" as const,
    providerUpdatedAt,
    retrievedAt: providerUpdatedAt,
    source: "buffer:post_metrics",
  });
  for (const h of input.history ?? []) {
    const at = new Date(input.publishedAt.getTime() + h.ageHours * HOUR);
    const rows = Object.entries(h.values).map(([k, v]) => row(k, v as number, at));
    if (rows.length) await db.insert(metricObservations).values(rows);
  }
  if (input.latest && input.metricsUpdatedAt) {
    const at = input.metricsUpdatedAt;
    const rows = Object.entries(input.latest).map(([k, v]) => row(k, v as number, at));
    if (rows.length) {
      await db.insert(metricObservations).values(rows).onConflictDoNothing();
      await db.insert(postMetricsLatest).values(rows.map((r) => ({ postId, metricKey: r.metricKey, value: r.value, valueStatus: r.valueStatus, unit: r.unit, providerUpdatedAt: at, retrievedAt: at, source: r.source })));
    }
  }
  if (input.tags?.length) await db.insert(postTags).values(input.tags.map((t) => ({ postId, kind: t.kind, value: t.value })));
  return postId;
}

/** Extracts the text drawn by pdfkit standard fonts from an UNCOMPRESSED PDF (WinAnsi hex strings in TJ arrays). */
export function extractPdfText(pdf: Buffer): string {
  const source = pdf.toString("latin1");
  const lines: string[] = [];
  for (const m of source.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    const chunks = [...(m[1] ?? "").matchAll(/<([0-9a-fA-F]*)>/g)].map((c) => Buffer.from(c[1] ?? "", "hex").toString("latin1"));
    lines.push(chunks.join(""));
  }
  return lines.join("\n");
}
