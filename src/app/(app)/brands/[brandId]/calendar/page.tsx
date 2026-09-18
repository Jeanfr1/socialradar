import type { Metadata } from "next";
import Link from "next/link";
import { PlatformTag } from "@/components/app/bits";
import { Icon } from "@/components/ui/Icon";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { orNotFound, param, type SearchParams } from "@/server/queries/pages/guard";
import { loadCalendar, type CalendarAlertVM, type CalendarDayVM, type CalendarPostStatus, type CalendarPostVM } from "@/server/queries/pages/workspace";

export const metadata: Metadata = { title: "Calendário" };

const WEEKDAYS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
const MAX_IN_CELL = 4;

const STATUS: Record<CalendarPostStatus, { label: string; mark: string; className: string }> = {
  published: { label: "Publicado", mark: "●", className: "text-ink" },
  scheduled: { label: "Agendado", mark: "○", className: "text-accent" },
  approval: { label: "Aguardando aprovação", mark: "◐", className: "text-warning" },
  failed: { label: "Falhou", mark: "✕", className: "text-critical" },
};

function PostChip({ post }: { post: CalendarPostVM }) {
  const s = STATUS[post.status];
  const content = (
    <>
      <span aria-hidden="true" className={`w-3 text-center text-[11px] leading-none ${s.className}`}>
        {s.mark}
      </span>
      <span className={`tabular-nums ${post.status === "published" ? "text-ink-2" : "text-ink"}`}>{post.time}</span>
      <PlatformTag platform={post.platform} className="ml-auto" />
      <span className="sr-only">
        {s.label} em @{post.handle}
        {post.title ? `: ${post.title}` : ""}
      </span>
    </>
  );
  const tip = [`${s.label} · @${post.handle}`, post.title].filter(Boolean).join("\n");
  return (
    <li title={tip}>
      {post.url ? (
        <a href={post.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[12px] hover:bg-canvas">
          {content}
        </a>
      ) : (
        <span className="flex items-center gap-1.5 px-1 py-0.5 text-[12px]">{content}</span>
      )}
    </li>
  );
}

function DayCell({ day }: { day: CalendarDayVM }) {
  const extra = day.posts.length - MAX_IN_CELL;
  return (
    <div
      className={`min-h-[118px] border-b border-r border-line p-1.5 ${!day.inMonth ? "bg-canvas/60" : day.isPast ? "bg-canvas/30" : "bg-surface"} ${
        day.isGap ? "relative ring-2 ring-inset ring-critical/70" : ""
      }`}
    >
      <div className="mb-1 flex items-center justify-between px-1">
        <span
          className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full text-xs ${
            day.isToday ? "bg-accent px-1.5 font-semibold text-white" : day.inMonth ? "text-ink" : "text-ink-2/60"
          }`}
        >
          {day.day}
        </span>
        {day.isGap ? <span className="text-[11px] font-semibold text-critical">sem post</span> : null}
      </div>
      {day.posts.length > 0 ? (
        <ul className="space-y-0.5">
          {day.posts.slice(0, MAX_IN_CELL).map((p) => (
            <PostChip key={p.id} post={p} />
          ))}
          {extra > 0 ? <li className="px-1 text-[11px] text-ink-2">+{extra} {extra === 1 ? "post" : "posts"}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

function AlertCard({ alert }: { alert: CalendarAlertVM }) {
  const critical = alert.kind === "next_day_gap";
  return (
    <div role={critical ? "alert" : "status"} className={`flex gap-3 rounded-xl border p-3.5 ${critical ? "border-critical/30 bg-[#fdf1f0]" : "border-warning/30 bg-[#fff6eb]"}`}>
      <Icon name={critical ? "alert-octagon" : "alert-triangle"} className={`mt-0.5 h-5 w-5 shrink-0 ${critical ? "text-critical" : "text-warning"}`} />
      <div className="min-w-0">
        <p className="font-semibold text-ink">{alert.title}</p>
        <p className="text-sm text-ink-2">{alert.detail}</p>
      </div>
      <PlatformTag platform={alert.platform} className="ml-auto mt-0.5 shrink-0" />
    </div>
  );
}

export default async function CalendarPage({ params, searchParams }: { params: Promise<{ brandId: string }>; searchParams: Promise<SearchParams> }) {
  const { brandId } = await params;
  const sp = await searchParams;
  const user = await requireUser("page");
  const vm = await orNotFound(loadCalendar(getDb(), user, brandId, { month: param(sp, "mes"), accountId: param(sp, "conta") }, new Date()));
  const base = `/brands/${vm.brand.id}/calendar`;
  const href = (month: string | null, account: string | null) => {
    const q = new URLSearchParams();
    if (month) q.set("mes", month);
    if (account) q.set("conta", account);
    const s = q.toString();
    return s ? `${base}?${s}` : base;
  };
  const days = vm.weeks.flat();
  const agenda = days.filter((d) => d.inMonth && (d.posts.length > 0 || d.isToday || d.isGap));
  const navBtn = "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 hover:text-ink";

  return (
    <div className="space-y-5">
      <h1 className="sr-only">Calendário de postagens de {vm.brand.name}</h1>

      {vm.alerts.length > 0 ? (
        <div className="space-y-2">
          {vm.alerts.map((a) => (
            <AlertCard key={`${a.kind}:${a.accountId}`} alert={a} />
          ))}
        </div>
      ) : (
        <p className="flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink-2">
          <Icon name="check-circle" className="h-5 w-5 text-healthy" />
          Tudo em dia: todas as contas que postam hoje já têm post agendado para amanhã.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link href={href(vm.month.prevKey, vm.selectedAccountId)} className={navBtn} aria-label="Mês anterior">
            ‹
          </Link>
          <h2 className="min-w-[10.5rem] text-center text-lg font-semibold text-ink">{vm.month.label}</h2>
          <Link href={href(vm.month.nextKey, vm.selectedAccountId)} className={navBtn} aria-label="Próximo mês">
            ›
          </Link>
          {!vm.month.isCurrent ? (
            <Link href={href(null, vm.selectedAccountId)} className="ml-1 rounded-lg px-2 py-1 text-sm text-accent hover:bg-accent-soft">
              Hoje
            </Link>
          ) : null}
        </div>
        {vm.accounts.length > 1 ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrar por conta">
            <Link
              href={href(vm.month.key, null)}
              aria-current={vm.selectedAccountId === null ? "true" : undefined}
              className={`rounded-full border px-3 py-1 text-sm ${vm.selectedAccountId === null ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink-2 hover:text-ink"}`}
            >
              Todas
            </Link>
            {vm.accounts.map((a) => (
              <Link
                key={a.id}
                href={href(vm.month.key, a.id)}
                aria-current={vm.selectedAccountId === a.id ? "true" : undefined}
                className={`inline-flex items-center gap-1.5 rounded-full border py-1 pl-1.5 pr-3 text-sm ${
                  vm.selectedAccountId === a.id ? "border-ink bg-ink text-white" : "border-line bg-surface text-ink-2 hover:text-ink"
                }`}
              >
                <PlatformTag platform={a.platform} />
                <span className="max-w-[10rem] truncate">{a.handle}</span>
              </Link>
            ))}
          </div>
        ) : null}
      </div>

      {/* Month grid (tablet and desktop) */}
      <div className="hidden overflow-hidden rounded-xl border-l border-t border-line md:block">
        <div className="grid grid-cols-7 border-b border-line bg-canvas">
          {WEEKDAYS.map((w) => (
            <div key={w} className="border-r border-line px-2 py-1.5 text-xs font-medium text-ink-2">
              {w}
            </div>
          ))}
        </div>
        {vm.weeks.map((week) => (
          <div key={week[0]!.date} className="grid grid-cols-7">
            {week.map((d) => (
              <DayCell key={d.date} day={d} />
            ))}
          </div>
        ))}
      </div>

      {/* Agenda (phones) */}
      <ol className="space-y-3 md:hidden">
        {agenda.length === 0 ? <li className="rounded-xl border border-line bg-surface p-4 text-sm text-ink-2">Nenhum post neste mês.</li> : null}
        {agenda.map((d) => (
          <li key={d.date} className={`rounded-xl border bg-surface p-3 ${d.isGap ? "border-critical/60" : "border-line"}`}>
            <p className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
              {d.weekday}, {d.day}
              {d.isToday ? <span className="rounded-full bg-accent px-2 text-[11px] font-semibold text-white">hoje</span> : null}
              {d.isGap ? <span className="text-xs font-semibold text-critical">sem post agendado</span> : null}
            </p>
            {d.posts.length > 0 ? (
              <ul className="space-y-0.5">
                {d.posts.map((p) => (
                  <PostChip key={p.id} post={p} />
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-ink-2">
        <div className="flex flex-wrap gap-3">
          {(["published", "scheduled", "approval", "failed"] as const).map((s) => (
            <span key={s} className="inline-flex items-center gap-1">
              <span aria-hidden="true" className={STATUS[s].className}>
                {STATUS[s].mark}
              </span>
              {STATUS[s].label}
            </span>
          ))}
        </div>
        <span>
          {vm.totals.published} publicados · {vm.totals.scheduled} agendados neste mês
          {vm.lastSync ? ` · atualizado ${vm.lastSync}` : ""}
        </span>
      </div>
    </div>
  );
}
