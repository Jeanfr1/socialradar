"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { regenerateReport } from "@/server/reports/service";
import type { ActionResult } from "@/components/forms/action-result";
import { fail, str, toActionError, uuidField } from "./_util";

/** Manager+: generates a new manual version for a week (runs synchronously), then opens it. */
export async function regenerateReportAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  let target: string;
  try {
    const user = await requireUser("action");
    const brandId = uuidField(formData, "brandId");
    const periodStart = str(formData, "periodStart");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) return fail("Escolha uma semana.");
    const row = await regenerateReport(getDb(), user, brandId, periodStart, new Date());
    revalidatePath(`/brands/${brandId}/reports`, "layout");
    revalidatePath(`/brands/${brandId}`);
    if (row.status === "failed") return fail("Não foi possível gerar o relatório por completo. A versão incompleta está listada no histórico.");
    target = `/brands/${brandId}/reports/${row.id}`;
  } catch (err) {
    return toActionError(err, "regenerateReport");
  }
  redirect(target);
}
