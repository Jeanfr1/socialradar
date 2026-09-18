import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { loadShell } from "@/server/queries/pages/shell";

/** Entry point: opens the calendar of the first brand. */
export default async function Home() {
  const user = await requireUser("page");
  const shell = await loadShell(getDb(), user);
  const first = shell.brands.find((b) => !b.isDemo) ?? shell.brands[0];
  redirect(first ? `/brands/${first.id}/calendar` : "/settings/brands");
}
