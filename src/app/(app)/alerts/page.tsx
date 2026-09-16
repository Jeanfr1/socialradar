import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertActions } from "@/components/alerts/AlertActions";
import { PageHeader } from "@/components/ui/Card";
import { DEFINITIONS } from "@/components/ui/copy";
import { DemoBadge, DemoBanner } from "@/components/ui/Demo";
import { InfoTip } from "@/components/ui/InfoTip";
import { Banner, EmptyState } from "@/components/ui/States";
import { Pill, SeverityBadge } from "@/components/ui/StatusBadge";
import { alertFormAction } from "@/server/actions/alerts";
import { ForbiddenError, NotFoundError, requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { ALERT_SEVERITIES, ALERT_STATES, ALERT_TYPES, loadAlerts, type AlertFilters, type AlertsVM } from "@/server/queries/pages/alerts";
import { oneOf, param, type SearchParams } from "@/server/queries/pages/guard";

export const metadata: Metadata = { title: "Alertas" };

const STATE_LABEL: Record<string, string> = { active: "Todos não resolvidos", open: "Em aberto", acknowledged: "Reconhecidos", snoozed: "Adiados", resolved: "Resolvidos (30 dias)" };
const STATE_BADGE_LABEL: Record<string, string> = { active: "Ativo", open: "Em aberto", acknowledged: "Reconhecido", snoozed: "Adiado", resolved: "Resolvido" };
const TYPE_LABEL: Record<string, string> = { all: "Todos os tipos", scheduling: "Agendamento", publishing: "Publicação", sync: "Sincronização" };

function hrefWith(filters: AlertFilters, patch: Partial<AlertFilters>) {
  const f = { ...filters, ...patch };
  const q = new URLSearchParams();
  if (f.severity !== "all") q.set("severity", f.severity);
  if (f.state !== "active") q.set("state", f.state);
  if (f.type !== "all") q.set("type", f.type);
  if (f.brand) q.set("brand", f.brand);
  if (f.account) q.set("account", f.account);
  const s = q.toString();
  return `/alerts${s ? `?${s}` : ""}`;
}

export default async function AlertsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const user = await requireUser("page");
  const filters: AlertFilters = {
    severity: oneOf(param(sp, "severity"), ALERT_SEVERITIES, "all"),
    state: oneOf(param(sp, "state"), ALERT_STATES, "active"),
    type: oneOf(param(sp, "type"), ALERT_TYPES, "all"),
    brand: param(sp, "brand"),
    account: param(sp, "account"),
  };

  let vm: AlertsVM;
  try {
    vm = await loadAlerts(getDb(), user, new Date(), filters);
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof ForbiddenError) notFound();
    return (
      <>
        <PageHeader title="Alertas" />
        <Banner tone="error" role="alert">
          Não foi possível carregar os alertas.{" "}
          <Link href={hrefWith(filters, {})} className="link font-medium" prefetch={false}>
            Tentar novamente
          </Link>
        </Banner>
      </>
    );
  }

  const tabs = [
    { key: "critical" as const, label: "Críticos", n: vm.counts.critical },
    { key: "warning" as const, label: "Atenção", n: vm.counts.warning },
    { key: "info" as const, label: "Informativos", n: vm.counts.info },
    { key: "all" as const, label: "Todos", n: vm.counts.all },
  ];

  return (
    <>
      <PageHeader
        title="Alertas"
        subtitle={`Problemas deduplicados em ${vm.isWorkspaceAdmin ? "suas marcas e conexões com o Buffer" : "suas marcas"}. A mesma condição é atualizada no lugar, em vez de gerar duplicatas.`}
      />
      {vm.hasDemo ? <DemoBanner scope="Alertas sinalizados como Demo vêm dos dados fictícios da marca de demonstração." /> : null}
      {vm.staleNote ? <Banner tone="stale">{vm.staleNote}</Banner> : null}
      {!vm.anyManageable && vm.items.length > 0 ? (
        <Banner tone="info">Você tem acesso somente leitura a estes alertas. Gerentes e proprietários podem reconhecer, adiar ou resolver.</Banner>
      ) : null}

      <nav aria-label="Severidade" className="mb-3 overflow-x-auto border-b border-line">
        <ul className="flex min-w-max gap-1">
          {tabs.map((t) => (
            <li key={t.key}>
              <Link
                href={hrefWith(vm.filters, { severity: t.key })}
                aria-current={vm.filters.severity === t.key ? "page" : undefined}
                className={`inline-flex min-h-10 items-center gap-2 border-b-2 px-3 text-sm ${vm.filters.severity === t.key ? "border-accent font-semibold text-accent" : "border-transparent text-ink-2 hover:text-ink"}`}
              >
                {t.label}
                <span className="rounded-full bg-canvas px-2 py-0.5 text-xs tabular-nums text-ink">{t.n}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <form method="get" action="/alerts" className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface p-3" aria-label="Filtros de alertas">
        {vm.filters.severity !== "all" ? <input type="hidden" name="severity" value={vm.filters.severity} /> : null}
        <div>
          <label htmlFor="a-brand" className="label text-xs">
            Marca
          </label>
          <select id="a-brand" name="brand" defaultValue={vm.filters.brand ?? ""} className="input">
            <option value="">Todas as marcas{vm.isWorkspaceAdmin ? " + conexões" : ""}</option>
            {vm.options.brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.isDemo ? " (Demo)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="a-account" className="label text-xs">
            Conta
          </label>
          <select id="a-account" name="account" defaultValue={vm.filters.account ?? ""} className="input">
            <option value="">Todas as contas</option>
            {vm.options.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="a-state" className="label text-xs">
            Status
          </label>
          <select id="a-state" name="state" defaultValue={vm.filters.state} className="input">
            {ALERT_STATES.map((s) => (
              <option key={s} value={s}>
                {STATE_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="a-type" className="label text-xs">
            Tipo
          </label>
          <select id="a-type" name="type" defaultValue={vm.filters.type} className="input">
            {ALERT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn-primary">
          Aplicar
        </button>
        <Link href="/alerts" className="btn btn-secondary">
          Limpar
        </Link>
      </form>

      {vm.items.length === 0 ? (
        vm.filters.state === "active" || vm.filters.state === "open" ? (
          <EmptyState title="Nenhum alerta em aberto.">Tudo está dentro dos limites configurados.</EmptyState>
        ) : (
          <EmptyState title="Nenhum alerta corresponde a estes filtros." />
        )
      ) : (
        <ul className="space-y-3">
          {vm.items.map((a) => (
            <li key={a.id}>
              <article aria-labelledby={`alert-${a.id}`} className={`rounded-lg border bg-surface p-4 ${a.severity === "critical" && a.state === "open" ? "border-critical/50" : "border-line"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={a.severity} />
                  <Pill>{a.typeLabel}</Pill>
                  <Pill tone={a.state === "open" ? "accent" : "neutral"}>{STATE_BADGE_LABEL[a.state] ?? a.state}</Pill>
                  {a.isDemo ? <DemoBadge /> : null}
                  <span className="text-xs text-ink-2">{a.updatedRelative}</span>
                </div>
                <h2 id={`alert-${a.id}`} className="mt-2 text-base font-semibold">
                  {a.title}
                </h2>
                <p className="text-sm text-ink-2">
                  {a.brandHref ? (
                    <Link href={a.brandHref} className="link">
                      {a.scope}
                    </Link>
                  ) : (
                    a.scope
                  )}
                </p>
                {a.evidence.length ? (
                  <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 rounded-md bg-canvas p-2 text-xs sm:grid-cols-2 xl:grid-cols-3">
                    {a.evidence.map((e) => (
                      <div key={e.label} className="flex min-w-0 gap-1">
                        <dt className="shrink-0 text-ink-2">{e.label}:</dt>
                        <dd className="min-w-0 break-words">{e.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                <p className="mt-2 text-sm">
                  <span className="font-medium">Ação sugerida: </span>
                  {a.suggestedAction}
                </p>
                <p className="mt-2 flex flex-wrap gap-x-3 text-xs text-ink-2">
                  <span>Detectado pela primeira vez em {a.firstDetected}</span>
                  <span>Detectado pela última vez em {a.lastDetected}</span>
                  <span>
                    {a.occurrenceCount > 1 ? `Mudou ${a.occurrenceCount - 1} ${a.occurrenceCount === 2 ? "vez" : "vezes"} · ` : ""}
                    {a.ongoingSince}
                  </span>
                  {a.stateLine ? <span>{a.stateLine}</span> : null}
                  {a.snoozedUntil ? (
                    <span className="inline-flex items-center">
                      Adiado até {a.snoozedUntil}
                      <InfoTip label="Sobre adiamento">{DEFINITIONS.snoozed}</InfoTip>
                    </span>
                  ) : null}
                </p>
                {a.canManage ? <AlertActions alertId={a.id} state={a.state} timezone={a.timezone} zone={a.zone} action={alertFormAction} /> : null}
              </article>
            </li>
          ))}
        </ul>
      )}
      {vm.truncated ? <p className="mt-3 text-sm text-ink-2">Exibindo os primeiros 300 alertas. Restrinja os filtros para ver mais.</p> : null}
    </>
  );
}
