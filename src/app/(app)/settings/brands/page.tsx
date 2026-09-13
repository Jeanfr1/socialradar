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

export const metadata: Metadata = { title: "Brand settings" };

export default async function BrandsSettingsPage() {
  const user = await requireUser("page");
  const vm = await loadBrandsSettings(getDb(), user);
  if (!vm.canCreate && !vm.brands.some((b) => b.canEdit)) {
    return <PermissionMessage title="Settings aren't available for your role">Viewers can see brand data but not change settings. Ask a brand manager or owner for changes.</PermissionMessage>;
  }
  return (
    <>
      <PageHeader title="Brands" subtitle="Brand profile, report language and schedule, members and per-account posting cadence." />
      {vm.canCreate ? (
        <Card labelledBy="create-brand" className="mb-4">
          <CardTitle id="create-brand">Create brand</CardTitle>
          <datalist id="tz-options">
            {vm.timezones.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
          <ActionForm action={createBrandAction} submitLabel="Create brand" pendingLabel="Creating…" className="max-w-3xl">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="nb-name" className="label">
                  Name
                </label>
                <input id="nb-name" name="name" required maxLength={80} className="input" />
              </div>
              <div>
                <label htmlFor="nb-tz" className="label">
                  Timezone
                </label>
                <input id="nb-tz" name="timezone" list="tz-options" defaultValue="America/Sao_Paulo" className="input" />
              </div>
              <div>
                <label htmlFor="nb-locale" className="label">
                  Report language
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
            <p className="text-xs text-ink-2">You become the brand owner. Map Buffer channels to it in Settings → Connections.</p>
          </ActionForm>
        </Card>
      ) : null}

      {vm.brands.length === 0 ? (
        <EmptyState title="No brands yet." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="data-table w-full text-sm">
            <caption className="sr-only">Brands you can access</caption>
            <thead>
              <tr>
                <th scope="col">Brand</th>
                <th scope="col">Your role</th>
                <th scope="col">Timezone</th>
                <th scope="col">Report language</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
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
                      {b.archived ? <Pill tone="warning">Archived</Pill> : null}
                    </span>
                  </th>
                  <td>{b.role}</td>
                  <td>{b.timezone}</td>
                  <td>{b.reportLocale}</td>
                  <td>
                    {b.canEdit ? (
                      <Link href={`/settings/brands/${b.id}`} className="link">
                        Edit settings
                      </Link>
                    ) : (
                      <span className="text-xs text-ink-2">View only</span>
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
