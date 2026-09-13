"use server";

/**
 * Alert state changes (manager or owner of the alert's brand; workspace admin for connection-level alerts).
 * Every change is audited. Snoozes that expire are reopened by the alert engine; escalations reopen early.
 */
import { DateTime } from "luxon";
import { revalidatePath } from "next/cache";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/server/audit";
import { isUniqueViolation, requireAlertAccess, requireUser } from "@/server/auth/authz";
import { getDb, type Db } from "@/server/db/client";
import { alerts, brands } from "@/server/db/schema";
import type { ActionResult } from "@/components/forms/action-result";
import { fail, ok, str, toActionError } from "./_util";

const MAX_SNOOZE_MS = 90 * 86_400_000;
const DURATIONS: Record<string, number> = { "1h": 3_600_000, "1d": 86_400_000, "1w": 7 * 86_400_000 };

function revalidate(brandId: string | null) {
  revalidatePath("/alerts");
  revalidatePath("/portfolio");
  if (brandId) revalidatePath(`/brands/${brandId}`, "layout");
}

async function load(alertId: string) {
  const user = await requireUser("action");
  const db = getDb();
  const access = await requireAlertAccess(db, user, alertId, "manager");
  return { user, db, ...access };
}

export async function acknowledgeAlert(alertId: string): Promise<ActionResult> {
  try {
    const { user, db, alert, brandId } = await load(alertId);
    if (alert.state === "resolved") return fail("This alert is already resolved.");
    if (alert.state === "acknowledged") return ok("Already acknowledged.");
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(alerts)
        .set({ state: "acknowledged", acknowledgedAt: now, acknowledgedBy: user.id, snoozedUntil: null, updatedAt: now })
        .where(and(eq(alerts.id, alert.id), ne(alerts.state, "resolved")));
      await recordAudit(tx as unknown as Db, {
        actorUserId: user.id,
        action: "alert_acknowledged",
        brandId,
        targetType: "alert",
        targetId: alert.id,
        metadata: { from: alert.state, type: alert.type, severity: alert.severity },
      });
    });
    revalidate(brandId);
    return ok("Alert acknowledged.");
  } catch (err) {
    return toActionError(err, "acknowledgeAlert");
  }
}

export async function snoozeAlert(alertId: string, until: Date): Promise<ActionResult> {
  try {
    const { user, db, alert, brandId } = await load(alertId);
    const now = new Date();
    if (!(until instanceof Date) || Number.isNaN(until.getTime())) return fail("Choose a valid snooze time.");
    if (until.getTime() <= now.getTime() + 5 * 60_000) return fail("Snooze time must be at least 5 minutes in the future.");
    if (until.getTime() > now.getTime() + MAX_SNOOZE_MS) return fail("Snooze for at most 90 days.");
    if (alert.state === "resolved") return fail("Resolved alerts can't be snoozed. Reopen it first.");
    await db.transaction(async (tx) => {
      await tx
        .update(alerts)
        .set({ state: "snoozed", snoozedUntil: until, updatedAt: now })
        .where(and(eq(alerts.id, alert.id), ne(alerts.state, "resolved")));
      await recordAudit(tx as unknown as Db, {
        actorUserId: user.id,
        action: "alert_snoozed",
        brandId,
        targetType: "alert",
        targetId: alert.id,
        metadata: { from: alert.state, snoozedUntil: until.toISOString(), type: alert.type, severity: alert.severity },
      });
    });
    revalidate(brandId);
    return ok("Alert snoozed. It resurfaces earlier if the condition gets worse.");
  } catch (err) {
    return toActionError(err, "snoozeAlert");
  }
}

export async function resolveAlert(alertId: string): Promise<ActionResult> {
  try {
    const { user, db, alert, brandId } = await load(alertId);
    if (alert.state === "resolved") return ok("Already resolved.");
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(alerts)
        .set({ state: "resolved", resolvedAt: now, resolvedBy: user.id, resolutionReason: "resolved_manually", snoozedUntil: null, updatedAt: now })
        .where(and(eq(alerts.id, alert.id), ne(alerts.state, "resolved")));
      await recordAudit(tx as unknown as Db, {
        actorUserId: user.id,
        action: "alert_resolved",
        brandId,
        targetType: "alert",
        targetId: alert.id,
        metadata: { from: alert.state, type: alert.type, severity: alert.severity },
      });
    });
    revalidate(brandId);
    return ok("Alert resolved. If the condition is still present, the next evaluation opens a new alert.");
  } catch (err) {
    return toActionError(err, "resolveAlert");
  }
}

/** Reopens a resolved, acknowledged or snoozed alert. (Audited as alert_resolved with transition "reopened" until a dedicated audit action exists.) */
export async function reopenAlert(alertId: string): Promise<ActionResult> {
  try {
    const { user, db, alert, brandId } = await load(alertId);
    if (alert.state === "open") return ok("Alert is already open.");
    const now = new Date();
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(alerts)
          .set({ state: "open", resolvedAt: null, resolvedBy: null, resolutionReason: null, acknowledgedAt: null, acknowledgedBy: null, snoozedUntil: null, updatedAt: now })
          .where(eq(alerts.id, alert.id));
        await recordAudit(tx as unknown as Db, {
          actorUserId: user.id,
          action: "alert_resolved",
          brandId,
          targetType: "alert",
          targetId: alert.id,
          metadata: { transition: "reopened", from: alert.state, to: "open", type: alert.type },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) return fail("A newer alert for this condition is already open.");
      throw err;
    }
    revalidate(brandId);
    return ok("Alert reopened.");
  } catch (err) {
    return toActionError(err, "reopenAlert");
  }
}

const formSchema = z.object({
  alertId: z.string().min(1),
  intent: z.enum(["acknowledge", "snooze", "resolve", "reopen"]),
  duration: z.enum(["1h", "1d", "1w", "custom"]).optional(),
  customUntil: z.string().max(40).optional(),
});

/** Single form entry point for the alert controls (the clicked button's `intent` selects the operation). */
export async function alertFormAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const parsed = formSchema.safeParse({
    alertId: str(formData, "alertId"),
    intent: str(formData, "intent"),
    duration: str(formData, "duration") || undefined,
    customUntil: str(formData, "customUntil") || undefined,
  });
  if (!parsed.success) return fail("Choose a valid action.");
  const { alertId, intent, duration, customUntil } = parsed.data;
  if (intent === "acknowledge") return acknowledgeAlert(alertId);
  if (intent === "resolve") return resolveAlert(alertId);
  if (intent === "reopen") return reopenAlert(alertId);

  if (!duration) return fail("Choose how long to snooze.");
  if (duration !== "custom") return snoozeAlert(alertId, new Date(Date.now() + (DURATIONS[duration] as number)));
  if (!customUntil) return fail("Pick a date and time to snooze until.");
  try {
    const user = await requireUser("action");
    const db = getDb();
    const { alert } = await requireAlertAccess(db, user, alertId, "manager");
    let tz = "UTC";
    if (alert.brandId) {
      const [b] = await db.select({ timezone: brands.timezone }).from(brands).where(eq(brands.id, alert.brandId)).limit(1);
      if (b && DateTime.local().setZone(b.timezone).isValid) tz = b.timezone;
    }
    const until = DateTime.fromISO(customUntil, { zone: tz });
    if (!until.isValid) return fail("Pick a valid date and time.");
    return snoozeAlert(alertId, until.toJSDate());
  } catch (err) {
    return toActionError(err, "alertFormAction");
  }
}
