/**
 * Shared helpers for server actions (not itself a "use server" module).
 * Error messages returned to the client are the services' safe, user-facing messages; unexpected errors are logged
 * (without form data) and replaced with a generic message.
 */
import { unstable_rethrow } from "next/navigation";
import { AppError, AuthError, ForbiddenError, NotFoundError, isUuid } from "@/server/auth/authz";
import { logger } from "@/server/logger";
import type { ActionResult } from "@/components/forms/action-result";

export function ok(message: string): ActionResult {
  return { status: "success", message };
}

export function fail(message: string): ActionResult {
  return { status: "error", message };
}

export function toActionError(err: unknown, context: string): ActionResult {
  unstable_rethrow(err);
  if (err instanceof AuthError) return fail("Sua sessão expirou. Entre novamente.");
  if (err instanceof NotFoundError) return fail("Este item não foi encontrado ou você não tem mais acesso a ele.");
  if (err instanceof ForbiddenError) return fail(err.message || "Você não tem permissão para fazer isso.");
  if (err instanceof AppError) return fail(err.message);
  logger.error(`action failed: ${context}`, { err });
  return fail("Algo deu errado. Tente novamente.");
}

export function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export function optionalStr(fd: FormData, key: string): string | null {
  const v = str(fd, key);
  return v === "" ? null : v;
}

export function uuidField(fd: FormData, key: string): string {
  const v = str(fd, key);
  if (!isUuid(v)) throw new NotFoundError();
  return v;
}

export function intField(fd: FormData, key: string): number | null {
  const v = str(fd, key);
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

export function checkbox(fd: FormData, key: string): boolean {
  return fd.get(key) === "on" || fd.get(key) === "true";
}
