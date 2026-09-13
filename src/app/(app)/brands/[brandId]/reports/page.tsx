import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/forms/ActionForm";
import { Card, CardTitle, PageHeader } from "@/components/ui/Card";
import { DemoBadge } from "@/components/ui/Demo";
import { Icon } from "@/components/ui/Icon";
import { EmptyState } from "@/components/ui/States";
import { Pill } from "@/components/ui/StatusBadge";
import { regenerateReportAction } from "@/server/actions/reports";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { orNotFound } from "@/server/queries/pages/guard";
import { loadReportList, type ReportVersionVM } from "@/server/queries/pages/reports";

export const metadata: Metadata = { title: "Weekly reports" };

function StatusPill({ v }: { v: ReportVersionVM }) {
  const tone = v.status === "final" ? "healthy" : v.status === "preliminary" ? "stale" : v.status === "failed" ? "critical" : "neutral";
  return <Pill tone={tone}>{v.statusLabel}</Pill>;
}

function Downloads({ v }: { v: ReportVersionVM }) {
  if (!v.canDownload) return null;
  return (
    <>
      <a href={`/api/reports/${v.id}/pdf`} className="btn btn-secondary min-h-9 px-2.5">
        <Icon name="download" /> PDF
      </a>
      <a href={`/api/reports/${v.id}/csv`} className="btn btn-secondary min-h-9 px-2.5">
        <Icon name="download" /> CSV
      </a>
    </>
  );
}

export default async function ReportsPage({ params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  const user = await requireUser("page");
  const vm = await orNotFound(loadReportList(getDb(), user, brandId, new Date()));
  const base = `/brands/${vm.brand.id}/reports`;

  return (
    <>
      <PageHeader
        title="Weekly reports"
        subtitle={`Report narratives are written in the brand's report language (${vm.brand.reportLocale}); the interface stays in English. Weeks run Monday–Sunday in ${vm.brand.timezone}.`}
        meta={vm.nextRun ? <span>Next scheduled report: {vm.nextRun}</span> : <span>Automatic weekly reports are turned off for this brand.</span>}
      />

      {vm.canRegenerate ? (
        <Card labelledBy="regen" className="mb-4">
          <CardTitle id="regen">Generate a new version</CardTitle>
          <ActionForm action={regenerateReportAction} hidden={{ brandId: vm.brand.id }} submitLabel="Regenerate report" pendingLabel="Generating… this can take a minute" inline>
            <div>
              <label htmlFor="period" className="label text-xs">
                Week
              </label>
              <select id="period" name="periodStart" defaultValue={vm.defaultPeriod} className="input">
                {vm.periodOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </ActionForm>
          <p className="text-xs text-ink-2">A new version is added to the week&apos;s history; earlier versions stay available.</p>
        </Card>
      ) : null}

      {vm.weeks.length === 0 ? (
        <EmptyState title="No reports yet.">
          {vm.nextRun ? `The first weekly report will generate on ${vm.nextRun}.` : "Automatic weekly reports are turned off; a manager can generate one above."}
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {vm.weeks.map((w) => (
            <li key={w.periodStart} className="rounded-lg border border-line bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-base font-semibold">{w.weekLabel}</h2>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-2">
                    <StatusPill v={w.latest} />
                    <Pill>{w.latest.locale.toUpperCase()}</Pill>
                    <span>v{w.latest.version}</span>
                    <span>{w.latest.trigger === "scheduled" ? "Scheduled" : "Manual"}</span>
                    <span>{w.latest.generated ? `Generated ${w.latest.generated}` : "Not generated yet"}</span>
                    {vm.brand.isDemo ? <DemoBadge /> : null}
                  </div>
                  {w.latest.status === "failed" && w.latest.errorMessage ? <p className="mt-1 text-xs text-critical">{w.latest.errorMessage}</p> : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link href={`${base}/${w.latest.id}`} className="btn btn-primary min-h-9 px-3">
                    {w.latest.status === "failed" ? "View partial report" : "View"}
                  </Link>
                  <Downloads v={w.latest} />
                </div>
              </div>
              {w.older.length ? (
                <details className="mt-3 text-sm">
                  <summary className="link cursor-pointer">Version history ({w.older.length} earlier)</summary>
                  <ul className="mt-2 divide-y divide-line">
                    {w.older.map((v) => (
                      <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span className="flex flex-wrap items-center gap-2">
                          v{v.version} <StatusPill v={v} /> <span className="text-xs text-ink-2">{v.generated ?? "—"}</span>
                        </span>
                        <span className="flex flex-wrap gap-2">
                          <Link href={`${base}/${v.id}`} className="link">
                            View
                          </Link>
                          <Downloads v={v} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
