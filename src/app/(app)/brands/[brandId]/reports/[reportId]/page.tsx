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

export const metadata: Metadata = { title: "Relatório" };

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
        <Link href={`${base}?tipo=${r.kind === "month" ? "mensal" : "semanal"}`} className="link">
          ← Todos os relatórios
        </Link>
      </p>
      <PageHeader
        title={`Relatório ${r.kind === "month" ? "mensal" : "semanal"}: ${r.weekLabel}`}
        meta={
          <>
            <Pill tone={r.status === "final" ? "healthy" : r.status === "preliminary" ? "stale" : r.status === "failed" ? "critical" : "neutral"}>{r.statusLabel}</Pill>
            <Pill>{r.locale.toUpperCase()}</Pill>
            <span>Versão {r.version}</span>
            <span>{r.trigger === "scheduled" ? "Agendado" : "Manual"}</span>
            <span>{r.generated ? `Gerado ${r.generated}` : "Ainda não gerado"}</span>
            {r.narrativeSource ? <span>Narrativa: {r.narrativeSource === "ai" ? "assistida por IA (validada contra os fatos)" : "determinística"}</span> : null}
            {r.isDemo || vm.brand.isDemo ? <DemoBadge /> : null}
          </>
        }
        actions={
          r.canDownload ? (
            <>
              <a href={`/api/reports/${r.id}/pdf`} className="btn btn-secondary">
                <Icon name="download" /> Baixar PDF
              </a>
              <a href={`/api/reports/${r.id}/csv`} className="btn btn-secondary">
                <Icon name="download" /> Baixar CSV
              </a>
            </>
          ) : null
        }
      />

      {latest && latest.id !== r.id ? (
        <Banner tone="info">
          Você está vendo a versão {r.version}. Existe uma versão mais recente:{" "}
          <Link href={`${base}/${latest.id}`} className="link">
            abrir a versão {latest.version} ({latest.statusLabel})
          </Link>
          .
        </Banner>
      ) : null}
      {r.status === "preliminary" || r.isPreliminary ? (
        <Banner tone="stale" role="status">
          Este relatório foi gerado com dados que ainda podem ser atualizados. Uma versão final o substituirá assim que todas as métricas forem sincronizadas.
        </Banner>
      ) : null}
      {r.status === "failed" ? (
        <Banner tone="error" role="alert">
          Não foi possível gerar este relatório por completo.{r.errorMessage ? ` ${r.errorMessage}` : ""} {vm.content ? "O relatório parcial é exibido abaixo." : ""} Fale com o suporte se isso continuar acontecendo.
        </Banner>
      ) : null}
      {r.status === "generating" ? <Banner tone="info">Esta versão ainda está sendo gerada. Atualize a página em um minuto.</Banner> : null}
      <p className="mb-4 text-xs text-ink-2">As seções narrativas estão no idioma de relatório da marca ({r.locale}).</p>

      <div className="grid gap-4 xl:grid-cols-[1fr_16rem]">
        <div className="min-w-0">{vm.content ? <ReportView content={vm.content} /> : <EmptyState title="Nenhum conteúdo de relatório disponível para esta versão." />}</div>
        <aside aria-labelledby="versions" className="h-fit rounded-lg border border-line bg-surface p-4 text-sm">
          <h2 id="versions" className="mb-2 font-semibold">
            Histórico de versões
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
            <ActionForm action={regenerateReportAction} hidden={{ brandId: vm.brand.id, periodStart: r.periodStart }} submitLabel="Gerar novamente esta semana" pendingLabel="Gerando…" variant="secondary" className="mt-4" />
          ) : null}
        </aside>
      </div>
    </>
  );
}
