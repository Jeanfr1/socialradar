import type { Metadata } from "next";
import { PeriodNav, PlatformTag, Segmented, nf } from "@/components/app/bits";
import { Icon } from "@/components/ui/Icon";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { oneOf, orNotFound, param, type SearchParams } from "@/server/queries/pages/guard";
import { loadRecommendations, type ContentHighlightVM, type InsightVM } from "@/server/queries/pages/workspace";

export const metadata: Metadata = { title: "Recomendações" };

const nf1 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const PRIORITY = {
  high: { label: "Prioridade alta", className: "bg-critical" },
  medium: { label: "Prioridade média", className: "bg-warning" },
  low: { label: "Prioridade baixa", className: "bg-ink-2/50" },
} as const;

function Insights({ items }: { items: InsightVM[] }) {
  return (
    <ul className="space-y-2">
      {items.map((i, idx) => (
        <li key={idx} className="flex items-start gap-2 text-sm text-ink">
          {i.platform ? <PlatformTag platform={i.platform} className="mt-0.5 shrink-0" /> : <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-2/60" />}
          <span>{i.text}</span>
        </li>
      ))}
    </ul>
  );
}

function PostList({ items, tone }: { items: ContentHighlightVM[]; tone: "up" | "down" }) {
  return (
    <ul className="divide-y divide-line">
      {items.slice(0, 3).map((p) => (
        <li key={p.id} className="flex items-center gap-3 py-2">
          <PlatformTag platform={p.platform} />
          <div className="min-w-0 flex-1">
            {p.url ? (
              <a href={p.url} target="_blank" rel="noopener noreferrer" className="line-clamp-1 text-sm text-ink hover:text-accent">
                {p.title ?? "Post sem legenda"}
              </a>
            ) : (
              <p className="line-clamp-1 text-sm text-ink">{p.title ?? "Post sem legenda"}</p>
            )}
            <p className="text-xs text-ink-2">
              @{p.handle} · {p.date} · {nf.format(p.views)} visualizações
            </p>
          </div>
          <span className={`shrink-0 text-xs font-semibold ${tone === "up" ? "text-healthy" : "text-critical"}`} title="Comparado com a mediana de posts parecidos da mesma conta e formato">
            {nf1.format(p.score)}× a média
          </span>
        </li>
      ))}
    </ul>
  );
}

function Column({
  title,
  icon,
  tone,
  children,
  empty,
}: {
  title: string;
  icon: "check-circle" | "alert-triangle" | "lightbulb";
  tone: string;
  children: React.ReactNode;
  empty: boolean;
}) {
  return (
    <section className="flex flex-col rounded-xl border border-line bg-surface p-4 sm:p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
        <Icon name={icon} className={`h-5 w-5 ${tone}`} />
        {title}
      </h2>
      {empty ? <p className="text-sm text-ink-2">Nada relevante neste período.</p> : <div className="space-y-4">{children}</div>}
    </section>
  );
}

export default async function RecommendationsPage({ params, searchParams }: { params: Promise<{ brandId: string }>; searchParams: Promise<SearchParams> }) {
  const { brandId } = await params;
  const sp = await searchParams;
  const periodParam = oneOf(param(sp, "periodo"), ["semana", "mes"] as const, "semana");
  const kind = periodParam === "mes" ? "month" : "week";
  const user = await requireUser("page");
  const vm = await orNotFound(loadRecommendations(getDb(), user, brandId, { kind, start: param(sp, "inicio") }, new Date()));
  const base = `/brands/${vm.brand.id}/recommendations`;
  const href = (start: string | null, k = periodParam) => `${base}?periodo=${k}${start ? `&inicio=${start}` : ""}`;

  return (
    <div className="space-y-5">
      <h1 className="sr-only">Recomendações para {vm.brand.name}</h1>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          active={periodParam}
          options={[
            { key: "semana", label: "Semana", href: href(null, "semana") },
            { key: "mes", label: "Mês", href: href(null, "mes") },
          ]}
        />
        <PeriodNav
          label={vm.period.label}
          prevHref={href(vm.period.prevStart)}
          nextHref={vm.period.nextStart ? href(vm.period.nextStart) : null}
          badge={vm.period.inProgress ? "em andamento" : null}
        />
      </div>

      {vm.isEmpty ? (
        <div className="rounded-xl border border-line bg-surface p-8 text-center">
          <Icon name="lightbulb" className="mx-auto h-8 w-8 text-ink-2" />
          <p className="mt-2 font-medium text-ink">Ainda não há dados suficientes neste período</p>
          <p className="text-sm text-ink-2">As recomendações aparecem quando há posts publicados com métricas para comparar.</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Column title="O que está funcionando" icon="check-circle" tone="text-healthy" empty={vm.working.length === 0 && vm.topContent.length === 0}>
            {vm.working.length > 0 ? <Insights items={vm.working} /> : null}
            {vm.topContent.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-2">Posts acima da média</p>
                <PostList items={vm.topContent} tone="up" />
              </div>
            ) : null}
          </Column>

          <Column title="O que não está funcionando" icon="alert-triangle" tone="text-warning" empty={vm.notWorking.length === 0 && vm.weakContent.length === 0}>
            {vm.notWorking.length > 0 ? <Insights items={vm.notWorking} /> : null}
            {vm.weakContent.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-2">Posts abaixo da média</p>
                <PostList items={vm.weakContent} tone="down" />
              </div>
            ) : null}
          </Column>

          <Column title="O que mudar" icon="lightbulb" tone="text-accent" empty={vm.changes.length === 0}>
            <ol className="space-y-3">
              {vm.changes.map((c, i) => (
                <li key={i} className="text-sm">
                  <p className="flex items-start gap-2 font-medium text-ink">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${PRIORITY[c.priority].className}`} title={PRIORITY[c.priority].label} />
                    <span>{c.title}</span>
                  </p>
                  <p className="ml-4 mt-0.5 text-ink-2">{c.description}</p>
                  <p className="ml-4 mt-0.5 text-xs text-ink-2">
                    <span className="font-medium">Como medir:</span> {c.successMetric}
                  </p>
                </li>
              ))}
            </ol>
          </Column>
        </div>
      )}

      <p className="text-xs text-ink-2">
        As recomendações vêm dos números do período e são hipóteses para testar, não certezas. &ldquo;× a média&rdquo; compara cada post com posts parecidos da mesma conta e formato.
      </p>
    </div>
  );
}
