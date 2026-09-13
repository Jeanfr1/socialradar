"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { LOGIN_ERROR_MESSAGE, login, logout } from "@/server/auth/session";
import type { ActionResult } from "@/components/forms/action-result";
import { logger } from "@/server/logger";

const loginSchema = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1024),
});

export async function loginAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const parsed = loginSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { status: "error", message: LOGIN_ERROR_MESSAGE };
  let succeeded = false;
  try {
    const result = await login(parsed.data.email, parsed.data.password);
    if (!result.ok) return { status: "error", message: result.error };
    succeeded = true;
  } catch (err) {
    logger.error("login action failed", { err });
    return { status: "error", message: LOGIN_ERROR_MESSAGE };
  }
  if (succeeded) redirect("/portfolio");
  return { status: "error", message: LOGIN_ERROR_MESSAGE };
}

export async function logoutAction(): Promise<void> {
  await logout();
  redirect("/login");
}
