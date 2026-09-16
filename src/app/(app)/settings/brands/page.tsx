import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/forms/ActionForm";
import { Card, CardTitle, PageHeader } from "@/components/ui/Card";
import { DemoBadge } from "@/components/ui/Demo";
import { EmptyState, PermissionMessage } from "@/components/ui/States";
import { Pill } from "@/components/ui/StatusBadge";
import { createBrandAction } from "@/server/actions/settings";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { loadBrandsSettings } from "@/server/queries/pages/settings";

export const metadata: Metadata = { title: "Configurações de marcas" };

const ROLE_LABEL: Record<string, string> = { owner: "Proprietário", manager: "Gerente", viewer: "Visualizador" };

export default async function BrandsSettingsPage() {
  const user = await requireUser("page");
  const vm = await loadBrandsSettings(getDb(), user);
  if (!vm.canCreate && !vm.brands.some((b) => b.canEdit)) {
    return <PermissionMessage title="As configurações não estão disponíveis para o seu papel">Visualizadores podem ver os dados da marca, mas não alterar as configurações. Peça as mudanças a um gerente ou proprietário da marca.</PermissionMessage>;
  }
  return (
    <>
      <PageHeader title="Marcas" subtitle="Perfil da marca, idioma e agenda do relatório, membros e cadência de publicação por conta." />
      {vm.canCreate ? (
        <Card labelledBy="create-brand" className="mb-4">
          <CardTitle id="create-brand">Criar marca</CardTitle>
          <datalist id="tz-options">
            {vm.timezones.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
          <ActionForm action={createBrandAction} submitLabel="Criar marca" pendingLabel="Criando…" className="max-w-3xl">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="nb-name" className="label">
                  Nome
                </label>
                <input id="nb-name" name="name" required maxLength={80} className="input" />
              </div>
              <div>
                <label htmlFor="nb-tz" className="label">
                  Fuso horário
                </label>
                <input id="nb-tz" name="timezone" list="tz-options" defaultValue="America/Sao_Paulo" className="input" />
              </div>
              <div>
                <label htmlFor="nb-locale" className="label">
                  Idioma do relatório
                </label>
                <select id="nb-locale" name="reportLocale" defaultValue="pt-BR" className="input">
                  {vm.locales.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="text-xs text-ink-2">Você se torna o proprietário da marca. Mapeie os canais do Buffer para ela em Configurações → Conexões.</p>
          </ActionForm>
        </Card>
      ) : null}

      {vm.brands.length === 0 ? (
        <EmptyState title="Nenhuma marca ainda." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="data-table w-full text-sm">
            <caption className="sr-only">Marcas às quais você tem acesso</caption>
            <thead>
              <tr>
                <th scope="col">Marca</th>
                <th scope="col">Seu papel</th>
                <th scope="col">Fuso horário</th>
                <th scope="col">Idioma do relatório</th>
                <th scope="col">
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {vm.brands.map((b) => (
                <tr key={b.id}>
                  <th scope="row" className="font-medium">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {b.name}
                      {b.isDemo ? <DemoBadge /> : null}
                      {b.archived ? <Pill tone="warning">Arquivada</Pill> : null}
                    </span>
                  </th>
                  <td>{ROLE_LABEL[b.role] ?? b.role}</td>
                  <td>{b.timezone}</td>
                  <td>{b.reportLocale}</td>
                  <td>
                    {b.canEdit ? (
                      <Link href={`/settings/brands/${b.id}`} className="link">
                        Editar configurações
                      </Link>
                    ) : (
                      <span className="text-xs text-ink-2">Somente leitura</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
