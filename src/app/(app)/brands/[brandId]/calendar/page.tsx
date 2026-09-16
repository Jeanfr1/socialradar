import type { Metadata } from "next";
import Link from "next/link";
import { CalendarItem, CalendarLegend, CellContent } from "@/components/calendar/CalendarParts";
import { Card, CardTitle, PageHeader } from "@/components/ui/Card";
import { Freshness } from "@/components/ui/Freshness";
import { Banner, EmptyState, ErrorBanner } from "@/components/ui/States";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { loadCalendar } from "@/server/queries/pages/calendar";
import { oneOf, orNotFound, param, type SearchParams } from "@/server/queries/pages/guard";

export const metadata: Metadata = { title: "Calendário de conteúdo" };

export default async function CalendarPage({ params, searchParams }: { params: Promise<{ brandId: string }>; searchParams: Promise<SearchParams> }) {
  const { brandId } = await params;
  const sp = await searchParams;
  const user = await requireUser("page");
  const view = oneOf(param(sp, "view"), ["month", "week"] as const, "month");
  const vm = await orNotFound(loadCalendar(getDb(), user, brandId, new Date(), { view, anchor: param(sp, "date"), accountId: param(sp, "account") }));
  const base = `/brands/${vm.brand.id}/calendar`;
  const href = (next: { view?: string; date?: string; account?: string | null }) => {
    const q = new URLSearchParams();
    q.set("view", next.view ?? vm.view);
    q.set("date", next.date ?? vm.anchor);
    const account = next.account === undefined ? vm.accountFilter : next.account;
    if (account) q.set("account", account);
    return `${base}?${q.toString()}`;
  };
  const scopeName = vm.accountFilter ? `@${vm.accounts.find((a) => a.id === vm.accountFilter)?.handle.replace(/^@/, "") ?? "esta conta"}` : vm.brand.name;

  return (
    <>
      <PageHeader
        title="Calendário de conteúdo"
        subtitle={`Posts agendados e publicados com os horários previstos da cadência. Horários em ${vm.brand.timezone} (${vm.brand.zone}).`}
        meta={<Freshness vm={vm.freshness} />}
      />

      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={href({ date: vm.prevAnchor })} className="btn btn-secondary" aria-label={vm.view === "month" ? "Mês anterior" : "Semana anterior"}>
            ‹ Anterior
          </Link>
          <Link href={href({ date: vm.todayAnchor })} className="btn btn-secondary">
            Hoje
          </Link>
          <Link href={href({ date: vm.nextAnchor })} className="btn btn-secondary" aria-label={vm.view === "month" ? "Próximo mês" : "Próxima semana"}>
            Próximo ›
          </Link>
          <h2 className="ml-1 text-lg font-semibold" aria-live="polite">
            {vm.title}
          </h2>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div role="group" aria-label="Visualização do calendário" className="flex gap-1">
            {(["month", "week"] as const).map((v) => (
              <Link key={v} href={href({ view: v })} aria-current={v === vm.view ? "true" : undefined} className={`btn ${v === vm.view ? "btn-primary" : "btn-secondary"}`}>
                {v === "month" ? "Mês" : "Semana"}
              </Link>
            ))}
          </div>
          <form method="get" action={base} className="flex items-end gap-2">
            <input type="hidden" name="view" value={vm.view} />
            <input type="hidden" name="date" value={vm.anchor} />
            <div>
              <label htmlFor="cal-account" className="label text-xs">
                Conta
              </label>
              <select id="cal-account" name="account" defaultValue={vm.accountFilter ?? ""} className="input">
                <option value="">Todas as contas</option>
                {vm.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    @{a.handle.replace(/^@/, "")} ({a.platformLabel})
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn-secondary">
              Aplicar
            </button>
          </form>
        </div>
      </div>

      {vm.error ? <ErrorBanner message={vm.error} retryHref={href({})} /> : null}
      {vm.freshness.level !== "fresh" ? <Banner tone="stale">{vm.freshness.label} — conteúdo agendado no Buffer desde então ainda não aparece aqui.</Banner> : null}
      {vm.upcomingEmpty ? (
        <Banner tone="warning" role="status">
          Nenhum conteúdo agendado encontrado para {scopeName} nesta visualização.
        </Banner>
      ) : null}
      {vm.accounts.filter((a) => a.unavailable).length ? (
        <div className="hatch-unavailable mb-3 rounded-lg border border-locked/30 p-2">
          <ul className="rounded bg-surface/95 p-2 text-sm">
            {vm.accounts
              .filter((a) => a.unavailable)
              .map((a) => (
                <li key={a.id}>
                  <strong>@{a.handle.replace(/^@/, "")}</strong> ({a.platformLabel}): {a.unavailable}. Uma faixa vazia aqui não significa &ldquo;sem posts&rdquo;.
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      <CalendarLegend />

      {vm.accounts.length === 0 ? (
        <EmptyState title="Nenhuma conta está mapeada para esta marca ainda." />
      ) : vm.view === "month" ? (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[760px] table-fixed text-left">
            <caption className="sr-only">
              Calendário de {vm.title} para {scopeName}
            </caption>
            <thead>
              <tr>
                {vm.weekdays.map((d) => (
                  <th key={d} scope="col" className="border-b border-line px-2 py-2 text-xs font-semibold text-ink-2">
                    {d}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {vm.weeks.map((week) => (
                <tr key={week[0]!.key}>
                  {week.map((cell) => (
                    <td key={cell.key} className={`border border-line align-top ${cell.inMonth ? "" : "bg-canvas"}`}>
                      <div className={`px-1 pt-1 text-xs ${cell.isToday ? "font-bold text-accent" : cell.inMonth ? "text-ink" : "text-ink-2"}`}>
                        <span className="sr-only">{cell.label}</span>
                        <span aria-hidden>{cell.dayNum}</span>
                        {cell.isToday ? <span className="ml-1">Hoje</span> : null}
                      </div>
                      <CellContent cell={cell} showHandles={!vm.accountFilter} maxItems={4} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[900px] table-fixed text-left">
            <caption className="sr-only">
              {vm.title}: uma faixa por conta para {scopeName}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="w-36 border-b border-line px-2 py-2 text-xs font-semibold text-ink-2">
                  Conta
                </th>
                {vm.lanes[0]?.cells.map((c) => (
                  <th key={c.key} scope="col" className={`border-b border-line px-2 py-2 text-xs font-semibold ${c.isToday ? "text-accent" : "text-ink-2"}`}>
                    {c.label}
                    {c.isToday ? " · Hoje" : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {vm.lanes.map((lane) => (
                <tr key={lane.accountId}>
                  <th scope="row" className="border border-line p-2 align-top text-sm font-medium">
                    @{lane.handle.replace(/^@/, "")}
                    <div className="text-xs font-normal text-ink-2">{lane.platformLabel}</div>
                  </th>
                  {lane.unavailable ? (
                    <td colSpan={lane.cells.length} className="hatch-unavailable border border-line p-2 align-middle">
                      <span className="rounded bg-surface px-2 py-1 text-sm font-medium text-locked">{lane.unavailable}</span>
                    </td>
                  ) : (
                    lane.cells.map((cell) => (
                      <td key={cell.key} className="border border-line align-top">
                        <CellContent cell={cell} showHandles={false} />
                      </td>
                    ))
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Card labelledBy="unconfirmed" className="mt-4">
        <CardTitle id="unconfirmed">Horário não confirmado</CardTitle>
        <p className="mb-2 text-xs text-ink-2">Rascunhos, posts aguardando aprovação e posts sem horário de publicação definido. Eles nunca contam como cobertura.</p>
        {vm.unconfirmed.length === 0 ? (
          <p className="text-sm text-ink-2">Nenhum post pendente sem horário confirmado.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {vm.unconfirmed.map((i) => (
              <li key={i.id}>
                <CalendarItem item={i} showHandle />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
