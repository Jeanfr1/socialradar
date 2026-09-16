"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { createExperimentFromRecommendation, updateExperiment, updateRecommendationStatus } from "@/server/insights/service";
import type { ActionResult } from "@/components/forms/action-result";
import { fail, ok, optionalStr, str, toActionError, uuidField } from "./_util";

const STATUS_MESSAGE: Record<string, string> = {
  accepted: "Recomendação aceita.",
  dismissed: "Recomendação descartada. Ela não será proposta novamente por 30 dias.",
  done: "Recomendação marcada como concluída.",
  proposed: "Recomendação restaurada.",
};

function revalidate(brandId: string) {
  revalidatePath(`/brands/${brandId}/recommendations`);
}

/** Manager+: accept, dismiss, mark done or restore a recommendation. */
export async function recommendationStatusAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser("action");
    const brandId = uuidField(formData, "brandId");
    const status = str(formData, "status");
    if (!["accepted", "dismissed", "done", "proposed"].includes(status)) return fail("Escolha um status válido.");
    await updateRecommendationStatus(getDb(), user, uuidField(formData, "recommendationId"), status as "accepted" | "dismissed" | "done" | "proposed");
    revalidate(brandId);
    return ok(STATUS_MESSAGE[status] ?? "Atualizado.");
  } catch (err) {
    return toActionError(err, "recommendationStatus");
  }
}

/** Manager+: starts tracking a recommendation as an experiment ("Mark as trying"). */
export async function createExperimentAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser("action");
    const brandId = uuidField(formData, "brandId");
    const exp = await createExperimentFromRecommendation(getDb(), user, uuidField(formData, "recommendationId"), {
      hypothesis: optionalStr(formData, "hypothesis") ?? undefined,
      startDate: str(formData, "startDate"),
      endDate: str(formData, "endDate"),
    });
    revalidate(brandId);
    return ok(exp.status === "running" ? `Em teste até ${exp.endDate}.` : `Experimento planejado de ${exp.startDate} a ${exp.endDate}.`);
  } catch (err) {
    return toActionError(err, "createExperiment");
  }
}

/** Manager+: update an experiment's status, end date or result summary. */
export async function updateExperimentAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser("action");
    const brandId = uuidField(formData, "brandId");
    const status = str(formData, "status");
    const patch: Parameters<typeof updateExperiment>[3] = {};
    if (status) {
      if (!["planned", "running", "completed", "abandoned"].includes(status)) return fail("Escolha um status válido.");
      patch.status = status as "planned" | "running" | "completed" | "abandoned";
    }
    const endDate = str(formData, "endDate");
    if (endDate) patch.endDate = endDate;
    if (formData.has("resultSummary")) patch.resultSummary = optionalStr(formData, "resultSummary");
    await updateExperiment(getDb(), user, uuidField(formData, "experimentId"), patch);
    revalidate(brandId);
    return ok("Experimento atualizado.");
  } catch (err) {
    return toActionError(err, "updateExperiment");
  }
}
