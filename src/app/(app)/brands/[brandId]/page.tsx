import type { Metadata } from "next";
import Link from "next/link";
import { SchedulingCard } from "@/components/health/SchedulingCard";
import { ErCell } from "@/components/content/MetricCell";
import { Card, CardTitle } from "@/components/ui/Card";
import { DEFINITIONS } from "@/components/ui/copy";
import { DemoBadge } from "@/components/ui/Demo";
import { Freshness } from "@/components/ui/Freshness";
import { Icon } from "@/components/ui/Icon";
import { InfoTip, Term } from "@/components/ui/InfoTip";
import { AudienceUnavailable, Banner, EmptyState, ErrorBanner } from "@/components/ui/States";
import { Pill, SeverityBadge, StatusBadge } from "@/components/ui/StatusBadge";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import type { Platform } from "@/domain/types";
import { loadBrandDashboard } from "@/server/queries/pages/brand-dashboard";
import { oneOf, orNotFound, param, type SearchParams } from "@/server/queries/pages/guard";

export const metadata: Metadata = { title: "Brand dashboard" };

const PLATFORMS = ["all", "instagram", "tiktok", "youtube"] as const;

export default async function BrandDashboardPage({ params, searchParams }: { params: Promise<{ brandId: string }>; searchParams: Promise<SearchParams> }) {
  const { brandId } = await params;
  const sp = await searchParams;
  const user = await requireUser("page");
  const range = oneOf(param(sp, "range"), ["7d", "28d"] as const, "7d");
  const platform = oneOf(param(sp, "platform"), PLATFORMS, "all");
  const vm = await orNotFound(loadBrandDashboard(getDb(), user, brandId, new Date(), { range, platform: platform as Platform | "all" }));
  const base = `/brands/${vm.brand.id}`;
  const href = (next: { range?: string; platform?: string }) => `${base}?range=${next.range ?? range}&platform=${next.platform ?? platform}`;

  return (
    <>
      <h1 className="sr-only">{vm.brand.name} dashboard</h1>
      {vm.staleData ? (
        <Banner tone="stale">
          Some data here is more than 24h old or older than its staleness window.{" "}
          <a href="#scheduling-details" className="link">
            See sync details
          </a>
        </Banner>
      ) : null}

      {vm.accounts.length === 0 ? (
        <EmptyState title="No accounts are mapped to this brand yet.">
          A workspace administrator can map discovered Buffer channels to this brand in Settings → Connections. Unmapped channels never
          appear in brand metrics.
        </EmptyState>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card labelledBy="ops-health">
            <CardTitle id="ops-health">Operational health</CardTitle>
            <p className="mb-3 text-xs text-ink-2">Scheduling and publishing only. Never blended with content performance.</p>
            {!vm.hasAnyPosts ? <p className="mb-3 rounded-md border border-line bg-canvas p-2 text-sm">No scheduled or sent posts found for this brand yet.</p> : null}
            <ul className="divide-y divide-line">
              {vm.accounts.map((a) => (
                <li key={a.accountId} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={`${base}/accounts/${a.accountId}`} className="link font-medium">
                      @{a.handle.replace(/^@/, "")}
                    </Link>
                    <span className="text-xs text-ink-2">{a.platformLabel}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <StatusBadge status={a.status} stale={!!a.stale} staleLabel={a.stale?.label} note={a.statusNote} />
                    {a.connectionIssue ? <Pill tone="critical">{a.connectionIssue}</Pill> : null}
                  </div>
                  <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <dt className="text-ink-2">
                        <Term term="Coverage" definition={DEFINITIONS.coverage} />:
                      </dt>
                      <dd className="tabular-nums">
                        {a.scheduling.unavailable ?? (a.scheduling.coveragePct ? `${a.scheduling.coveragePct} · ${a.scheduling.coveredDays ?? "0 days"} continuous` : "No expected slots")}
                      </dd>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <dt className="text-ink-2">
                        <Term term="First uncovered slot" definition={DEFINITIONS.firstUncovered} />:
                      </dt>
                      <dd>{a.scheduling.unavailable ?? a.scheduling.firstUncoveredSlot ?? "None in horizon"}</dd>
                    </div>
                  </dl>
                  {a.needsLine ? <p className="mt-1 text-sm font-medium text-ink">{a.needsLine}</p> : null}
                  <div className="mt-1">
                    <Freshness vm={a.freshness} />
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card labelledBy="content-perf">
            <CardTitle
              id="content-perf"
              actions={
                <div className="flex flex-wrap gap-1" role="group" aria-label="Performance period">
                  {(["7d", "28d"] as const).map((r) => (
                    <Link key={r} href={href({ range: r })} aria-current={r === range ? "true" : undefined} className={`btn ${r === range ? "btn-primary" : "btn-secondary"} min-h-9 px-3`}>
                      {r === "7d" ? "Last 7 days" : "Last 28 days"}
                    </Link>
                  ))}
                </div>
              }
            >
              Content performance
            </CardTitle>
            <nav aria-label="Platform filter" className="mb-3 flex flex-wrap gap-1 text-sm">
              {PLATFORMS.map((p) => (
                <Link key={p} href={href({ platform: p })} aria-current={p === platform ? "true" : undefined} className={`rounded-full border px-2.5 py-1 ${p === platform ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line text-ink-2 hover:text-ink"}`}>
                  {p === "all" ? "All platforms" : p === "instagram" ? "Instagram" : p === "tiktok" ? "TikTok" : "YouTube"}
                </Link>
              ))}
            </nav>
            {vm.performance.error ? <ErrorBanner message={vm.performance.error} retryHref={href({})} /> : null}
            {!vm.performance.error && vm.performance.platforms.every((p) => p.postsPublished === 0) ? (
              <p className="rounded-md border border-line bg-canvas p-3 text-sm">No content data yet — once posts are published, performance will appear here.</p>
            ) : null}
            {vm.performance.platforms.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="data-table w-full text-sm">
                  <caption className="sr-only">Top-line metrics per platform; lifetime values as of each post&apos;s last provider refresh</caption>
                  <thead>
                    <tr>
                      <th scope="col">Platform</th>
                      <th scope="col">Posts</th>
                      <th scope="col">Views</th>
                      <th scope="col">Median reach</th>
                      <th scope="col">
                        <span className="inline-flex items-center">
                          Median eng. rate
                          <InfoTip label="About Engagement rate" align="right">
                            {DEFINITIONS.erReach} {DEFINITIONS.erViews} Rates use different definitions per platform and are never compared across platforms.
                          </InfoTip>
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {vm.performance.platforms.map((p) => (
                      <tr key={p.platform}>
                        <th scope="row" className="font-medium">
                          {p.label}
                          <div className="text-[11px] font-normal text-ink-2">{p.metricsAsOf ? `Metrics as of ${p.metricsAsOf}` : "No metrics yet"}</div>
                        </th>
                        <td className="tabular-nums">{p.postsPublished}</td>
                        <td className="tabular-nums">
                          <span className="inline-flex items-center">
                            {p.views.display}
                            {p.views.note ? <InfoTip label={`About ${p.label} views`}>{p.views.note}</InfoTip> : null}
                          </span>
                        </td>
                        <td className="tabular-nums">
                          <span className="inline-flex items-center">
                            <span className={p.medianReach.display === "Unsupported" ? "text-xs italic text-ink-2" : ""}>{p.medianReach.display}</span>
                            {p.medianReach.note ? <InfoTip label={`About ${p.label} reach`}>{p.medianReach.note}</InfoTip> : null}
                          </span>
                        </td>
                        <td className="tabular-nums">
                          <span className="inline-flex items-center">
                            {p.medianEr.display}
                            <InfoTip label={`About ${p.label} engagement rate`} align="right">
                              {p.medianEr.note} Definition id: {p.medianEr.definitionId}.
                            </InfoTip>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <h3 className="mb-2 mt-4 flex items-center text-sm font-semibold">
              Top posts this period
              {vm.performance.rankingMethod ? <InfoTip label="How posts are ranked">{vm.performance.rankingMethod}</InfoTip> : null}
            </h3>
            {vm.performance.topPosts.length === 0 ? (
              <p className="text-sm text-ink-2">{vm.performance.rankingNote ?? "No ranked posts in this period."}</p>
            ) : (
              <ol className="space-y-2">
                {vm.performance.topPosts.map((t, i) => (
                  <li key={t.postId} className="rounded-md border border-line p-2 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <span className="min-w-0 font-medium">
                        {i + 1}. {t.title}
                      </span>
                      <ErCell cell={t.er} />
                    </div>
                    <p className="text-xs text-ink-2">
                      @{t.handle.replace(/^@/, "")} · {t.platformLabel} · {t.publishedAt} ·{" "}
                      <span className="font-medium text-ink">{t.ratio}</span> · {t.confidence} confidence
                    </p>
                    <p className="mt-1 text-xs text-ink-2">{t.explanation}</p>
                    {t.externalUrl ? (
                      <a href={t.externalUrl} target="_blank" rel="noopener noreferrer" className="link mt-1 inline-flex items-center gap-1 text-xs">
                        Open original post <Icon name="external" className="h-3 w-3" />
                        <span className="sr-only">(opens in a new tab)</span>
                      </a>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-3">
              <Link href={`${base}/content`} className="link text-sm">
                Full content performance
              </Link>
            </p>
          </Card>

          <Card labelledBy="this-week">
            <CardTitle id="this-week">This week</CardTitle>
            {vm.thisWeek ? (
              <>
                <p className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-2">
                  Week {vm.thisWeek.periodLabel} <Pill tone={vm.thisWeek.status === "Final" ? "healthy" : "stale"}>{vm.thisWeek.status}</Pill> <Pill>{vm.thisWeek.locale.toUpperCase()}</Pill>
                </p>
                <div lang={vm.thisWeek.locale} className="text-sm">
                  <p className="line-clamp-6 whitespace-pre-line">{vm.thisWeek.summary}</p>
                  {vm.thisWeek.highlights.length ? (
                    <ul className="mt-2 list-disc space-y-0.5 pl-5">
                      {vm.thisWeek.highlights.map((h, i) => (
                        <li key={i}>{h}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <p className="mt-2">
                  <Link href={`${base}/reports/${vm.thisWeek.reportId}`} className="link text-sm">
                    Open full report
                  </Link>
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-ink-2">No weekly report yet. Reports summarize publishing consistency, best content and prioritized actions.</p>
                <p className="mt-2">
                  <Link href={`${base}/reports`} className="link text-sm">
                    Open weekly reports
                  </Link>
                </p>
              </>
            )}
          </Card>

          <Card labelledBy="brand-alerts">
            <CardTitle
              id="brand-alerts"
              actions={
                <Link href={`/alerts?brand=${vm.brand.id}`} className="link text-sm">
                  All {vm.openAlertCount} open alerts
                </Link>
              }
            >
              Alerts
            </CardTitle>
            {vm.alerts.length === 0 ? (
              <p className="text-sm text-ink-2">No open alerts. Everything is within your configured thresholds.</p>
            ) : (
              <ul className="space-y-2">
                {vm.alerts.map((a) => (
                  <li key={a.id} className="rounded-md border border-line p-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={a.severity} />
                      <span className="font-medium">{a.title}</span>
                      {a.isDemo ? <DemoBadge /> : null}
                    </div>
                    <p className="mt-1 text-ink-2">{a.suggestedAction}</p>
                    <p className="mt-0.5 text-xs text-ink-2">{a.updated}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card labelledBy="audience" className="xl:col-span-2">
            <CardTitle id="audience">Audience growth</CardTitle>
            <AudienceUnavailable />
          </Card>
        </div>
      )}

      {vm.accounts.length > 0 ? (
        <section id="scheduling-details" aria-labelledby="sched-heading" className="mt-6">
          <h2 id="sched-heading" className="mb-3 text-lg font-semibold">
            Scheduling details per account
          </h2>
          <div className="grid gap-4 2xl:grid-cols-2">
            {vm.accounts.map((a) => (
              <SchedulingCard key={a.accountId} vm={a} headingId={`sched-${a.accountId}`} detailHref={`${base}/accounts/${a.accountId}`} />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
