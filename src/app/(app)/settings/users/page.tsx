import type { Metadata } from "next";
import { ActionForm } from "@/components/forms/ActionForm";
import { Card, CardTitle, PageHeader } from "@/components/ui/Card";
import { EmptyState, ErrorBanner, PermissionMessage } from "@/components/ui/States";
import { Pill } from "@/components/ui/StatusBadge";
import { createUserAction, setUserActiveAction } from "@/server/actions/settings";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { loadUsersSettings, type UsersSettingsVM } from "@/server/queries/pages/settings";

export const metadata: Metadata = { title: "Users & roles" };

export default async function UsersPage() {
  const user = await requireUser("page");
  if (!user.isWorkspaceAdmin) {
    return <PermissionMessage title="Users are managed by workspace administrators">Brand owners can manage members of their brands in Settings → Brands.</PermissionMessage>;
  }
  let vm: UsersSettingsVM;
  try {
    vm = await loadUsersSettings(getDb(), user, new Date());
  } catch {
    return (
      <>
        <PageHeader title="Users & roles" />
        <ErrorBanner message="We couldn't load users." retryHref="/settings/users" />
      </>
    );
  }
  return (
    <>
      <PageHeader title="Users & roles" subtitle="Invite-only access. Create accounts here, then assign brand roles in each brand's settings." />
      <Card labelledBy="new-user" className="mb-4">
        <CardTitle id="new-user">Create user</CardTitle>
        <ActionForm action={createUserAction} submitLabel="Create user" pendingLabel="Creating…" className="max-w-3xl">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="u-name" className="label">
                Name
              </label>
              <input id="u-name" name="name" required maxLength={120} className="input" />
            </div>
            <div>
              <label htmlFor="u-email" className="label">
                Email
              </label>
              <input id="u-email" name="email" type="email" required className="input" autoComplete="off" />
            </div>
            <div>
              <label htmlFor="u-pass" className="label">
                Temporary password
              </label>
              <input id="u-pass" name="password" type="password" required autoComplete="new-password" className="input" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isWorkspaceAdmin" className="h-4 w-4" /> Workspace administrator (manages connections, users and brand creation)
          </label>
        </ActionForm>
      </Card>

      {vm.users.length <= 1 ? <EmptyState title="No team members yet besides you.">Create a user above to invite someone.</EmptyState> : null}
      <div className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="data-table w-full text-sm">
          <caption className="sr-only">Workspace users</caption>
          <thead>
            <tr>
              <th scope="col">User</th>
              <th scope="col">Role</th>
              <th scope="col">Brands you can see</th>
              <th scope="col">Last login</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {vm.users.map((u) => (
              <tr key={u.id}>
                <th scope="row" className="font-medium">
                  {u.name} {u.isSelf ? <Pill>You</Pill> : null}
                  <div className="text-xs font-normal text-ink-2">{u.email}</div>
                </th>
                <td>{u.isWorkspaceAdmin ? <Pill tone="accent">Workspace admin</Pill> : <span className="text-ink-2">Member</span>}</td>
                <td className="max-w-xs text-xs">{u.brands.length ? u.brands.join(", ") : <span className="text-ink-2">None</span>}</td>
                <td className="text-xs">{u.lastLogin}</td>
                <td>
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={u.isActive ? "healthy" : "warning"}>{u.isActive ? "Active" : "Inactive"}</Pill>
                    {!u.isSelf ? (
                      <ActionForm action={setUserActiveAction} hidden={{ userId: u.id, active: u.isActive ? "false" : "true" }} submitLabel={u.isActive ? "Deactivate" : "Reactivate"} variant={u.isActive ? "danger" : "secondary"} inline />
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
