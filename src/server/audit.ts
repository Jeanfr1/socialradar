/** Append-only audit trail. Metadata is always redacted and reduced to plain JSON before storage. Server-only. */
import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { auditEvents } from "@/server/db/schema";
import { redact } from "@/server/security/redact";

export const AUDIT_ACTIONS = [
  "login_succeeded",
  "login_failed",
  "logout",
  "connection_created",
  "connection_validated",
  "connection_rotated",
  "connection_removed",
  "account_mapped",
  "account_unmapped",
  "account_ignored",
  "brand_created",
  "brand_updated",
  "member_added",
  "member_role_changed",
  "member_removed",
  "user_created",
  "user_updated",
  "report_regenerated",
  "report_downloaded",
  "export_downloaded",
  "alert_acknowledged",
  "alert_snoozed",
  "alert_resolved",
  "settings_updated",
  "demo_seeded",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEventInput {
  actorUserId: string | null;
  action: AuditAction;
  brandId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

const MAX_METADATA_BYTES = 8_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toJsonMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};
  const json = JSON.stringify(redact(metadata), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  if (!json || json.length > MAX_METADATA_BYTES) return { truncated: true };
  return JSON.parse(json) as Record<string, unknown>;
}

/** Records an audit event. Pass the transaction handle when auditing inside a transaction. */
export async function recordAudit(db: Db, event: AuditEventInput): Promise<void> {
  if (!(AUDIT_ACTIONS as readonly string[]).includes(event.action)) {
    throw new Error(`Unknown audit action: ${String(event.action)}`);
  }
  await db.insert(auditEvents).values({
    actorUserId: event.actorUserId,
    action: event.action,
    brandId: event.brandId ?? null,
    targetType: event.targetType ?? null,
    targetId: event.targetId ?? null,
    metadata: toJsonMetadata(event.metadata),
  });
}

/** Workspace-admin audit log listing (newest first, keyset pagination by id). */
export async function listAuditEvents(
  db: Db,
  actor: { id: string; isWorkspaceAdmin: boolean },
  opts: { limit?: number; beforeId?: number; brandId?: string } = {},
) {
  // Inline check (importing authz here would create an import cycle through session.ts).
  if (!actor?.isWorkspaceAdmin) throw new Error("Only workspace administrators can read the audit log.");
  if (opts.brandId !== undefined && !UUID_RE.test(opts.brandId)) return [];
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const filters = [
    opts.beforeId !== undefined ? lt(auditEvents.id, opts.beforeId) : undefined,
    opts.brandId !== undefined ? eq(auditEvents.brandId, opts.brandId) : undefined,
  ].filter((f) => f !== undefined);
  return db
    .select()
    .from(auditEvents)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(auditEvents.id))
    .limit(limit);
}
