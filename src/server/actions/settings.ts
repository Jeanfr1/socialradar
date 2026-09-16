"use server";

/**
 * Settings mutations. Authorization is enforced by the services (workspace admin for connections/users/brand
 * creation; manager/owner roles for brand settings, members and cadence). Buffer API keys are read from the form,
 * passed straight to the connection service and never returned, logged or echoed.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser, requireWorkspaceAdmin } from "@/server/auth/authz";
import {
  addMember,
  changeRole,
  createBrand,
  createUser,
  mapAccountToBrand,
  removeMember,
  setAccountIgnored,
  setBrandArchived,
  setUserActive,
  updateBrand,
  updatePostingSchedule,
  type PostingScheduleInput,
} from "@/server/brands/service";
import { createConnection, getConnection, removeConnection, revalidateConnection, rotateCredential } from "@/server/connections/service";
import { getDb } from "@/server/db/client";
import { enqueueJob } from "@/server/jobs/queue";
import { JOB_KINDS } from "@/server/jobs/scheduler";
import { validateBufferCredential } from "@/server/providers/buffer/validate";
import type { ActionResult } from "@/components/forms/action-result";
import { checkbox, fail, intField, ok, optionalStr, str, toActionError, uuidField } from "./_util";

type Role = "owner" | "manager" | "viewer";
const ROLES: Role[] = ["owner", "manager", "viewer"];

async function queueDiscovery(connectionId: string) {
  await enqueueJob(getDb(), { kind: JOB_KINDS.syncQueue, payload: { connectionId }, dedupeKey: `${JOB_KINDS.syncQueue}:${connectionId}` });
}

// ---------------------------------------------------------------------------
// Connections (workspace admin)
// ---------------------------------------------------------------------------
export async function createConnectionAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser("action");
    const label = str(formData, "label");
    const raw = formData.get("apiKey");
    const secret = typeof raw === "string" ? raw : "";
    const conn = await createConnection(
      getDb(),
      user,
      { provider: "buffer", secret, label: label || ((acc) => `Buffer – ${acc.externalAccountName}`.slice(0, 80)) },
      validateBufferCredential,
    );
    await queueDiscovery(conn.id);
    revalidatePath("/settings/connections");
    return ok(`Conexão "${conn.label}" criada. A chave (${conn.keyHint ?? "oculta"}) foi validada com o Buffer e armazenada criptografada. A descoberta de canais foi enfileirada.`);
  } catch (err) {
    return toActionError(err, "createConnection");
  }
}

export async function rotateCredentialAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser("action");
    const connectionId = uuidField(formData, "connectionId");
    const raw = formData.get("apiKey");
    const conn = await rotateCredential(getDb(), user, connectionId, typeof raw === "string" ? raw : "", validateBufferCredential);
    revalidatePath("/settings/connections");
    return ok(`Chave substituída e validada (${conn.keyHint ?? "oculta"}).`);
  } catch (err) {
    return toActionError(err, "rotateCredential");
  }
}

export async function revalidateConnectionAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser("action");
    const conn = await revalidateConnection(getDb(), user, uuidField(formData, "connectionId"), validateBufferCredential);
    revalidatePath("/settings/connections");
    return conn.status === "active" ? ok("O Buffer aceitou a chave armazenada.") : fail(`Falha na validação: a conexão agora está como "${conn.status}". ${conn.lastErrorMessage ?? ""}`.trim());
  } catch (err) {
    return toActionError(err, "revalidateConnection");
  }
}

export async function rediscoverChannelsAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser("action");
    requireWorkspaceAdmin(user);
    const conn = await getConnection(getDb(), user, uuidField(formData, "connectionId"));
    await queueDiscovery(conn.id);
    revalidatePath("/settings/connections");
    return ok("Descoberta de canais enfileirada. Ela roda no próximo ciclo do worker, sujeita às reservas de cota do Buffer.");
  } catch (err) {
    return toActionError(err, "rediscoverChannels");
  }
}

export async function removeConnectionAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser("action");
    if (!checkbox(formData, "confirm")) return fail("Confirme que você quer remover esta conexão.");
    await removeConnection(getDb(), user, uuidField(formData, "connectionId"));
    revalidatePath("/settings/connections");
    revalidatePath("/portfolio");
    return ok("Conexão removida. A chave armazenada foi apagada; os dados históricos foram mantidos.");
  } catch (err) {
    return toActionError(err, "removeConnection");
  }
}

export async function mapAccountAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser("action");
    const accountId = uuidField(formData, "accountId");
    const brandId = optionalStr(formData, "brandId");
    await mapAccountToBrand(getDb(), user, accountId, brandId === null ? null : uuidField(formData, "brandId"));
    revalidatePath("/settings/connections");
    revalidatePath("/portfolio");
    if (brandId) revalidatePath(`/brands/${brandId}`, "layout");
    return ok(brandId ? "Canal vinculado. A partir de agora ele aparece nos dashboards da marca." : "Canal desvinculado. Ele não aparece mais em nenhuma marca.");
  } catch (err) {
    return toActionError(err, "mapAccount");
  }
}

export async function ignoreAccountAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser("action");
    const ignored = str(formData, "ignored") === "true";
    await setAccountIgnored(getDb(), user, uuidField(formData, "accountId"), ignored);
    revalidatePath("/settings/connections");
    revalidatePath("/portfolio");
    return ok(ignored ? "Canal ignorado." : "Canal restaurado para a lista de vinculação.");
  } catch (err) {
    return toActionError(err, "ignoreAccount");
  }
}

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------
export async function createBrandAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  let brandId: string;
  try {
    const user = await requireUser("action");
    const brand = await createBrand(getDb(), user, {
      name: str(formData, "name"),
      timezone: str(formData, "timezone") || undefined,
      reportLocale: (str(formData, "reportLocale") || undefined) as "pt-BR" | "en-US" | "es-ES" | undefined,
    });
    brandId = brand.id;
    revalidatePath("/", "layout");
  } catch (err) {
    return toActionError(err, "createBrand");
  }
  redirect(`/settings/brands/${brandId}`);
}

export async function updateBrandAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser("action");
    const brandId = uuidField(formData, "brandId");
    const time = /^(\d{2}):(\d{2})$/.exec(str(formData, "reportTime"));
    if (!time) return fail("O horário do relatório precisa usar HH:MM (formato 24 horas).");
    const day = intField(formData, "reportDay");
    await updateBrand(getDb(), user, brandId, {
      name: str(formData, "name"),
      logoUrl: optionalStr(formData, "logoUrl"),
      timezone: str(formData, "timezone"),
      reportLocale: str(formData, "reportLocale") as "pt-BR" | "en-US" | "es-ES",
      businessGoals: optionalStr(formData, "businessGoals"),
      contentPillars: str(formData, "contentPillars")
        .split(/[\n,]/)
        .map((p) => p.trim())
        .filter(Boolean),
      reportSchedule: { enabled: checkbox(formData, "reportEnabled"), dayOfWeek: day ?? 1, hour: Number(time[1]), minute: Number(time[2]) },
    });
    revalidatePath("/", "layout");
    return ok("Configurações da marca salvas.");
  } catch (err) {
    return toActionError(err, "updateBrand");
  }
}

export async function archiveBrandAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser("action");
    const archived = str(formData, "archived") === "true";
    await setBrandArchived(getDb(), user, uuidField(formData, "brandId"), archived);
    revalidatePath("/", "layout");
    return ok(archived ? "Marca arquivada. Ela não aparece mais nos dashboards; os dados foram mantidos." : "Marca restaurada.");
  } catch (err) {
    return toActionError(err, "archiveBrand");
  }
}

export async function addMemberAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser("action");
    const brandId = uuidField(formData, "brandId");
    const role = str(formData, "role") as Role;
    if (!ROLES.includes(role)) return fail("Escolha um perfil.");
    const member = await addMember(getDb(), user, brandId, { email: str(formData, "email"), role });
    revalidatePath(`/settings/brands/${brandId}`);
    return ok(`${member.name} adicionado como ${member.role}.`);
  } catch (err) {
    return toActionError(err, "addMember");
  }
}

export async function changeRoleAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser("action");
    const brandId = uuidField(formData, "brandId");
    const role = str(formData, "role") as Role;
    if (!ROLES.includes(role)) return fail("Escolha um perfil.");
    await changeRole(getDb(), user, brandId, uuidField(formData, "userId"), role);
    revalidatePath(`/settings/brands/${brandId}`);
    return ok("Perfil atualizado.");
  } catch (err) {
    return toActionError(err, "changeRole");
  }
}

export async function removeMemberAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser("action");
    const brandId = uuidField(formData, "brandId");
    await removeMember(getDb(), user, brandId, uuidField(formData, "userId"));
    revalidatePath(`/settings/brands/${brandId}`);
    return ok("Membro removido desta marca.");
  } catch (err) {
    return toActionError(err, "removeMember");
  }
}

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

function parseTimes(raw: string): string[] | null {
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(part);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    out.push(`${m[1]!.padStart(2, "0")}:${m[2]}`);
  }
  return out;
}

export async function updateCadenceAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser("action");
    const accountId = uuidField(formData, "accountId");
    const slots: NonNullable<PostingScheduleInput["slots"]> = [];
    for (const day of DAYS) {
      const times = parseTimes(str(formData, `times_${day}`));
      if (times === null) return fail(`Os horários de ${day.toUpperCase()} precisam ser valores HH:MM separados por vírgulas.`);
      const paused = checkbox(formData, `paused_${day}`);
      if (times.length || paused) slots.push({ day, paused, times });
    }
    const nums = {
      postsPerWeek: intField(formData, "postsPerWeek"),
      matchToleranceMinutes: intField(formData, "matchToleranceMinutes"),
      horizonDays: intField(formData, "horizonDays"),
      warningDays: intField(formData, "warningDays"),
      criticalDays: intField(formData, "criticalDays"),
      staleAfterMinutes: intField(formData, "staleAfterMinutes"),
    };
    for (const [k, v] of Object.entries(nums)) {
      if (Number.isNaN(v)) return fail(`${k} precisa ser um número inteiro.`);
      if (v === null && k !== "postsPerWeek") return fail(`${k} é obrigatório.`);
    }
    const schedule = await updatePostingSchedule(getDb(), user, accountId, {
      mode: str(formData, "mode") as PostingScheduleInput["mode"],
      timezone: optionalStr(formData, "timezone"),
      slots,
      matchMode: str(formData, "matchMode") as PostingScheduleInput["matchMode"],
      postsPerWeek: nums.postsPerWeek,
      matchToleranceMinutes: nums.matchToleranceMinutes as number,
      horizonDays: nums.horizonDays as number,
      warningDays: nums.warningDays as number,
      criticalDays: nums.criticalDays as number,
      staleAfterMinutes: nums.staleAfterMinutes as number,
    });
    revalidatePath("/", "layout");
    return ok(`Cadência salva (${schedule.mode.replace(/_/g, " ")}). A cobertura e os alertas passam a usá-la a partir da próxima avaliação.`);
  } catch (err) {
    return toActionError(err, "updateCadence");
  }
}

// ---------------------------------------------------------------------------
// Users (workspace admin)
// ---------------------------------------------------------------------------
export async function createUserAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser("action");
    const raw = formData.get("password");
    const created = await createUser(getDb(), user, {
      name: str(formData, "name"),
      email: str(formData, "email"),
      password: typeof raw === "string" ? raw : "",
      isWorkspaceAdmin: checkbox(formData, "isWorkspaceAdmin"),
    });
    revalidatePath("/settings/users");
    return ok(`${created.name} já pode entrar. Compartilhe a senha temporária por um canal seguro e depois atribua as marcas em Configurações → Marcas.`);
  } catch (err) {
    return toActionError(err, "createUser");
  }
}

export async function setUserActiveAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser("action");
    const active = str(formData, "active") === "true";
    await setUserActive(getDb(), user, uuidField(formData, "userId"), active);
    revalidatePath("/settings/users");
    return ok(active ? "Usuário reativado." : "Usuário desativado e desconectado de todas as sessões.");
  } catch (err) {
    return toActionError(err, "setUserActive");
  }
}
