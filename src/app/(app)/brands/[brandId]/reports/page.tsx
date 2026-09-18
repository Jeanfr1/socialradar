import type { Metadata } from "next";
import Link from "next/link";
import { Segmented } from "@/components/app/bits";
import { Icon } from "@/components/ui/Icon";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { oneOf, orNotFound, param, type SearchParams } from "@/server/queries/pages/guard";
import { loadReportsList } from "@/server/queries/pages/workspace";

export const metadata: Metadata = { title: "Relatórios" };

const STATUS = {
  final: { label: "Final", className: "bg-[#e8f5ee] text-healthy" },
  preliminary: { label: "Preliminar", className: "bg-[#fff6e0] text-stale" },
  generating: { label: "Gerando", className: "bg-accent-soft text-accent" },
  failed: { label: "Falhou", className: "bg-[#fdf1f0] text-critical" },
} as const;

export default async function ReportsPage({ params, searchParams }: { params: Promise<{ brandId: string }>; searchParams: Promise<SearchParams> }) {
  const { brandId } = await params;
  const sp = await searchParams;
  const tipo = oneOf(param(sp, "tipo"), ["semanal", "mensal"] as const, "semanal");
  const kind = tipo === "mensal" ? "month" : "week";
  const user = await requireUser("page");
  const vm = await orNotFound(loadReportsList(getDb(), user, brandId, kind, new Date()));
  const base = `/brands/${vm.brand.id}/reports`;

  return (
    <div className="space-y-5">
      <h1 className="sr-only">Relatórios de {vm.brand.name}</h1>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          active={tipo}
          options={[
            { key: "semanal", label: "Semanais", href: `${base}?tipo=semanal` },
            { key: "mensal", label: "Mensais", href: `${base}?tipo=mensal` },
          ]}
        />
        <p className="text-sm text-ink-2">
          {kind === "week" ? "Gerado toda segunda-feira às 08:00, sobre a semana anterior." : "Gerado todo dia 1º às 08:00, sobre o mês anterior."}
        </p>
      </div>

      {vm.items.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-8 text-center">
          <Icon name="file" className="mx-auto h-8 w-8 text-ink-2" />
          <p className="mt-2 font-medium text-ink">Nenhum relatório {kind === "week" ? "semanal" : "mensal"} ainda</p>
          <p className="text-sm text-ink-2">
            {kind === "week" ? "O primeiro será gerado na próxima segunda-feira." : "O primeiro será gerado no dia 1º do próximo mês."}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {vm.items.map((r) => {
            const s = STATUS[r.status];
            const ready = r.status === "final" || r.status === "preliminary";
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <Link href={`${base}/${r.id}`} className="font-medium text-ink hover:text-accent">
                    {r.label}
                  </Link>
                  <p className="text-xs text-ink-2">{r.generatedAt ? `Gerado ${r.generatedAt}` : "Aguardando geração"}</p>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.className}`}>{s.label}</span>
                {ready ? (
                  <div className="flex items-center gap-1">
                    <Link href={`${base}/${r.id}`} className="rounded-lg px-2.5 py-1.5 text-sm text-accent hover:bg-accent-soft">
                      Abrir
                    </Link>
                    <a href={`/api/reports/${r.id}/pdf`} className="rounded-lg px-2.5 py-1.5 text-sm text-ink-2 hover:bg-canvas hover:text-ink" title="Baixar PDF">
                      PDF
                    </a>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-ink-2">
        &ldquo;Preliminar&rdquo; significa que parte das métricas ainda estava sendo atualizada pelas redes; uma versão final substitui automaticamente.
      </p>
    </div>
  );
}
