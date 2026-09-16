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
    if (alert.state === "resolved") return fail("Este alerta já foi resolvido.");
    if (alert.state === "acknowledged") return ok("Já foi reconhecido.");
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
    return ok("Alerta reconhecido.");
  } catch (err) {
    return toActionError(err, "acknowledgeAlert");
  }
}

export async function snoozeAlert(alertId: string, until: Date): Promise<ActionResult> {
  try {
    const { user, db, alert, brandId } = await load(alertId);
    const now = new Date();
    if (!(until instanceof Date) || Number.isNaN(until.getTime())) return fail("Escolha um horário de adiamento válido.");
    if (until.getTime() <= now.getTime() + 5 * 60_000) return fail("O horário do adiamento precisa estar pelo menos 5 minutos no futuro.");
    if (until.getTime() > now.getTime() + MAX_SNOOZE_MS) return fail("Adie por no máximo 90 dias.");
    if (alert.state === "resolved") return fail("Alertas resolvidos não podem ser adiados. Reabra o alerta primeiro.");
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
    return ok("Alerta adiado. Ele volta antes se a condição piorar.");
  } catch (err) {
    return toActionError(err, "snoozeAlert");
  }
}

export async function resolveAlert(alertId: string): Promise<ActionResult> {
  try {
    const { user, db, alert, brandId } = await load(alertId);
    if (alert.state === "resolved") return ok("Já foi resolvido.");
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
    return ok("Alerta resolvido. Se a condição ainda existir, a próxima avaliação abre um novo alerta.");
  } catch (err) {
    return toActionError(err, "resolveAlert");
  }
}

/** Reopens a resolved, acknowledged or snoozed alert. (Audited as alert_resolved with transition "reopened" until a dedicated audit action exists.) */
export async function reopenAlert(alertId: string): Promise<ActionResult> {
  try {
    const { user, db, alert, brandId } = await load(alertId);
    if (alert.state === "open") return ok("O alerta já está aberto.");
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
      if (isUniqueViolation(err)) return fail("Já existe um alerta mais recente aberto para esta condição.");
      throw err;
    }
    revalidate(brandId);
    return ok("Alerta reaberto.");
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
  if (!parsed.success) return fail("Escolha uma ação válida.");
  const { alertId, intent, duration, customUntil } = parsed.data;
  if (intent === "acknowledge") return acknowledgeAlert(alertId);
  if (intent === "resolve") return resolveAlert(alertId);
  if (intent === "reopen") return reopenAlert(alertId);

  if (!duration) return fail("Escolha por quanto tempo adiar.");
  if (duration !== "custom") return snoozeAlert(alertId, new Date(Date.now() + (DURATIONS[duration] as number)));
  if (!customUntil) return fail("Escolha a data e a hora até quando adiar.");
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
    if (!until.isValid) return fail("Escolha uma data e hora válidas.");
    return snoozeAlert(alertId, until.toJSDate());
  } catch (err) {
    return toActionError(err, "alertFormAction");
  }
}
