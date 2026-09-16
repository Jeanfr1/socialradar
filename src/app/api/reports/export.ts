import { AuthError, ConflictError, ForbiddenError, NotFoundError, requireUser, type Actor } from "@/server/auth/authz";
import { getDb, type Db } from "@/server/db/client";
import { logger } from "@/server/logger";

const BASE_HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function text(status: number, message: string): Response {
  return new Response(message, { status, headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
}

/** Authorizes through the report service and streams the export with safe headers. */
export async function exportReport(
  reportId: string,
  render: (db: Db, actor: Actor, reportId: string) => Promise<{ filename: string; body: Buffer | string }>,
  contentType: string,
): Promise<Response> {
  let user: Actor;
  try {
    user = await requireUser("action");
  } catch {
    return text(401, "Entre na sua conta para continuar.");
  }
  try {
    const { filename, body } = await render(getDb(), user, reportId);
    const payload = typeof body === "string" ? body : new Uint8Array(body);
    return new Response(payload, {
      status: 200,
      headers: { ...BASE_HEADERS, "Content-Type": contentType, "Content-Disposition": contentDisposition(filename) },
    });
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ForbiddenError) return text(404, "Não encontrado.");
    if (err instanceof AuthError) return text(401, "Entre na sua conta para continuar.");
    if (err instanceof ConflictError) return text(409, err.message);
    logger.error("report export failed", { err, reportId });
    return text(500, "Não foi possível exportar este relatório. Tente novamente.");
  }
}
