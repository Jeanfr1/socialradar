import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/forms/ActionForm";
import { ReportView } from "@/components/reports/ReportView";
import { PageHeader } from "@/components/ui/Card";
import { DemoBadge } from "@/components/ui/Demo";
import { Icon } from "@/components/ui/Icon";
import { Banner, EmptyState } from "@/components/ui/States";
import { Pill } from "@/components/ui/StatusBadge";
import { regenerateReportAction } from "@/server/actions/reports";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { orNotFound } from "@/server/queries/pages/guard";
import { loadReportView } from "@/server/queries/pages/reports";

export const metadata: Metadata = { title: "Weekly report" };

export default async function ReportPage({ params }: { params: Promise<{ brandId: string; reportId: string }> }) {
  const { brandId, reportId } = await params;
  const user = await requireUser("page");
  const vm = await orNotFound(loadReportView(getDb(), user, brandId, reportId, new Date()));
  const r = vm.report;
  const base = `/brands/${vm.brand.id}/reports`;
  const latest = vm.versions[0];

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={base} className="link">
          ← All reports
        </Link>
      </p>
      <PageHeader
        title={`Weekly report: ${r.weekLabel}`}
        meta={
          <>
            <Pill tone={r.status === "final" ? "healthy" : r.status === "preliminary" ? "stale" : r.status === "failed" ? "critical" : "neutral"}>{r.statusLabel}</Pill>
            <Pill>{r.locale.toUpperCase()}</Pill>
            <span>Version {r.version}</span>
            <span>{r.trigger === "scheduled" ? "Scheduled" : "Manual"}</span>
            <span>{r.generated ? `Generated ${r.generated}` : "Not generated yet"}</span>
            {r.narrativeSource ? <span>Narrative: {r.narrativeSource === "ai" ? "AI-assisted (validated against facts)" : "deterministic"}</span> : null}
            {r.isDemo || vm.brand.isDemo ? <DemoBadge /> : null}
          </>
        }
        actions={
          r.canDownload ? (
            <>
              <a href={`/api/reports/${r.id}/pdf`} className="btn btn-secondary">
                <Icon name="download" /> Download PDF
              </a>
              <a href={`/api/reports/${r.id}/csv`} className="btn btn-secondary">
                <Icon name="download" /> Download CSV
              </a>
            </>
          ) : null
        }
      />

      {latest && latest.id !== r.id ? (
        <Banner tone="info">
          You are viewing version {r.version}. A newer version exists:{" "}
          <Link href={`${base}/${latest.id}`} className="link">
            open version {latest.version} ({latest.statusLabel})
          </Link>
          .
        </Banner>
      ) : null}
      {r.status === "preliminary" || r.isPreliminary ? (
        <Banner tone="stale" role="status">
          This report was generated with data that may still be updating. A finalized version will replace it once all metrics have synced.
        </Banner>
      ) : null}
      {r.status === "failed" ? (
        <Banner tone="error" role="alert">
          This week&apos;s report couldn&apos;t be generated in full.{r.errorMessage ? ` ${r.errorMessage}` : ""} {vm.content ? "The partial report is shown below." : ""} Contact support if this keeps happening.
        </Banner>
      ) : null}
      {r.status === "generating" ? <Banner tone="info">This version is still being generated. Refresh in a minute.</Banner> : null}
      <p className="mb-4 text-xs text-ink-2">Narrative sections are in the brand&apos;s report language ({r.locale}). Buttons and navigation stay in English.</p>

      <div className="grid gap-4 xl:grid-cols-[1fr_16rem]">
        <div className="min-w-0">{vm.content ? <ReportView content={vm.content} /> : <EmptyState title="No report content is available for this version." />}</div>
        <aside aria-labelledby="versions" className="h-fit rounded-lg border border-line bg-surface p-4 text-sm">
          <h2 id="versions" className="mb-2 font-semibold">
            Version history
          </h2>
          <ol className="space-y-2">
            {vm.versions.map((v) => (
              <li key={v.id} className={v.id === r.id ? "font-semibold" : ""}>
                {v.id === r.id ? (
                  <span aria-current="page">
                    v{v.version} · {v.statusLabel}
                  </span>
                ) : (
                  <Link href={`${base}/${v.id}`} className="link">
                    v{v.version} · {v.statusLabel}
                  </Link>
                )}
                <div className="text-xs font-normal text-ink-2">{v.generatedRelative ? `${v.generatedRelative} · ${v.trigger}` : v.trigger}</div>
              </li>
            ))}
          </ol>
          {vm.canRegenerate ? (
            <ActionForm action={regenerateReportAction} hidden={{ brandId: vm.brand.id, periodStart: r.periodStart }} submitLabel="Regenerate this week" pendingLabel="Generating…" variant="secondary" className="mt-4" />
          ) : null}
        </aside>
      </div>
    </>
  );
}
