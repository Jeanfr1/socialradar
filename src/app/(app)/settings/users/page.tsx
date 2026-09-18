import type { Metadata } from "next";
import { ActionForm } from "@/components/forms/ActionForm";
import { Card, CardTitle, PageHeader } from "@/components/ui/Card";
import { EmptyState, ErrorBanner, PermissionMessage } from "@/components/ui/States";
import { Pill } from "@/components/ui/StatusBadge";
import { createUserAction, setUserActiveAction } from "@/server/actions/settings";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { loadUsersSettings, type UsersSettingsVM } from "@/server/queries/pages/settings";

export const metadata: Metadata = { title: "Usuários e papéis" };

export default async function UsersPage() {
  const user = await requireUser("page");
  if (!user.isWorkspaceAdmin) {
    return <PermissionMessage title="Os usuários são gerenciados pelos administradores do workspace">Proprietários de marca podem gerenciar os membros das suas marcas em Configurações → Marcas.</PermissionMessage>;
  }
  let vm: UsersSettingsVM;
  try {
    vm = await loadUsersSettings(getDb(), user, new Date());
  } catch {
    return (
      <>
        <PageHeader title="Usuários e papéis" />
        <ErrorBanner message="Não foi possível carregar os usuários." retryHref="/settings/users" />
      </>
    );
  }
  return (
    <>
      <PageHeader title="Usuários e papéis" subtitle="Acesso apenas por convite. Crie as contas aqui e depois atribua os papéis nas configurações de cada marca." />
      <Card labelledBy="new-user" className="mb-4">
        <CardTitle id="new-user">Criar usuário</CardTitle>
        <ActionForm action={createUserAction} submitLabel="Criar usuário" pendingLabel="Criando…" className="max-w-3xl">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="u-name" className="label">
                Nome
              </label>
              <input id="u-name" name="name" required maxLength={120} className="input" />
            </div>
            <div>
              <label htmlFor="u-email" className="label">
                E-mail
              </label>
              <input id="u-email" name="email" type="email" required className="input" autoComplete="off" />
            </div>
            <div>
              <label htmlFor="u-pass" className="label">
                Senha temporária
              </label>
              <input id="u-pass" name="password" type="password" required autoComplete="new-password" className="input" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isWorkspaceAdmin" className="h-4 w-4" /> Administrador do workspace (gerencia conexões, usuários e criação de marcas)
          </label>
        </ActionForm>
      </Card>

      {vm.users.length <= 1 ? <EmptyState title="Ainda não há outros membros além de você.">Crie um usuário acima para convidar alguém.</EmptyState> : null}
      <div className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="data-table w-full text-sm">
          <caption className="sr-only">Usuários do workspace</caption>
          <thead>
            <tr>
              <th scope="col">Usuário</th>
              <th scope="col">Papel</th>
              <th scope="col">Marcas que você pode ver</th>
              <th scope="col">Último acesso</th>
              <th scope="col">Situação</th>
            </tr>
          </thead>
          <tbody>
            {vm.users.map((u) => (
              <tr key={u.id}>
                <th scope="row" className="font-medium">
                  {u.name} {u.isSelf ? <Pill>Você</Pill> : null}
                  <div className="text-xs font-normal text-ink-2">{u.email}</div>
                </th>
                <td>{u.isWorkspaceAdmin ? <Pill tone="accent">Admin do workspace</Pill> : <span className="text-ink-2">Membro</span>}</td>
                <td className="max-w-xs text-xs">{u.brands.length ? u.brands.join(", ") : <span className="text-ink-2">Nenhuma</span>}</td>
                <td className="text-xs">{u.lastLogin}</td>
                <td>
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={u.isActive ? "healthy" : "warning"}>{u.isActive ? "Ativo" : "Inativo"}</Pill>
                    {!u.isSelf ? (
                      <ActionForm action={setUserActiveAction} hidden={{ userId: u.id, active: u.isActive ? "false" : "true" }} submitLabel={u.isActive ? "Desativar" : "Reativar"} variant={u.isActive ? "danger" : "secondary"} inline />
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
