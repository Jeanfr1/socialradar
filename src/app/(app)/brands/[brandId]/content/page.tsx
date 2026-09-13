import type { Metadata } from "next";
import Link from "next/link";
import { ErCell, MetricCell } from "@/components/content/MetricCell";
import { TrendChart } from "@/components/content/TrendChart";
import { Card, CardTitle, PageHeader } from "@/components/ui/Card";
import { DEFINITIONS } from "@/components/ui/copy";
import { Icon } from "@/components/ui/Icon";
import { InfoTip } from "@/components/ui/InfoTip";
import { AudienceUnavailable, EmptyState, ErrorBanner } from "@/components/ui/States";
import { Pill } from "@/components/ui/StatusBadge";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { CONTENT_SORTS, loadContent, type ContentVM } from "@/server/queries/pages/content";
import { oneOf, orNotFound, param, type SearchParams } from "@/server/queries/pages/guard";

export const metadata: Metadata = { title: "Content performance" };

const SORT_LABEL: Record<string, string> = { recent: "Most recent", views: "Views", reach: "Reach", er: "Engagement rate", comments: "Comments", shares: "Shares" };

function pageHref(vm: ContentVM, page: number) {
  const q = new URLSearchParams();
  const f = vm.filters;
  for (const [k, v] of Object.entries({ q: f.q, account: f.account, platform: f.platform, format: f.format, tag: f.tag, from: f.from, to: f.to, sort: f.sort })) if (v) q.set(k, v);
  q.set("page", String(page));
  return `/brands/${vm.brand.id}/content?${q.toString()}`;
}

export default async function ContentPage({ params, searchParams }: { params: Promise<{ brandId: string }>; searchParams: Promise<SearchParams> }) {
  const { brandId } = await params;
  const sp = await searchParams;
  const user = await requireUser("page");
  const vm = await orNotFound(
    loadContent(getDb(), user, brandId, new Date(), {
      q: param(sp, "q"),
      account: param(sp, "account"),
      platform: param(sp, "platform"),
      format: param(sp, "format"),
      tag: param(sp, "tag"),
      from: param(sp, "from"),
      to: param(sp, "to"),
      sort: oneOf(param(sp, "sort"), CONTENT_SORTS, "recent"),
      page: Number(param(sp, "page") ?? 1) || 1,
    }),
  );
  const base = `/brands/${vm.brand.id}/content`;
  const f = vm.filters;

  return (
    <>
      <PageHeader title="Content performance" subtitle={`Published posts and their lifetime metrics. Dates in ${vm.brand.timezone}.`} />

      <form method="get" action={base} className="mb-4 rounded-lg border border-line bg-surface p-3" aria-label="Content filters">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <div className="sm:col-span-2">
            <label htmlFor="f-q" className="label text-xs">
              Search captions
            </label>
            <input id="f-q" name="q" type="search" defaultValue={f.q ?? ""} className="input" />
          </div>
          <div>
            <label htmlFor="f-account" className="label text-xs">
              Account
            </label>
            <select id="f-account" name="account" defaultValue={f.account ?? ""} className="input">
              <option value="">All</option>
              {vm.options.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="f-platform" className="label text-xs">
              Platform
            </label>
            <select id="f-platform" name="platform" defaultValue={f.platform ?? ""} className="input">
              <option value="">All</option>
              {vm.options.platforms.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="f-format" className="label text-xs">
              Format
            </label>
            <select id="f-format" name="format" defaultValue={f.format ?? ""} className="input">
              <option value="">All</option>
              {vm.options.formats.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="f-tag" className="label text-xs">
              Tag
            </label>
            <select id="f-tag" name="tag" defaultValue={f.tag ?? ""} className="input">
              <option value="">All</option>
              {vm.options.tags.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="f-from" className="label text-xs">
              From
            </label>
            <input id="f-from" name="from" type="date" defaultValue={f.from} className="input" />
          </div>
          <div>
            <label htmlFor="f-to" className="label text-xs">
              To
            </label>
            <input id="f-to" name="to" type="date" defaultValue={f.to} className="input" />
          </div>
          <div>
            <label htmlFor="f-sort" className="label text-xs">
              Sort by
            </label>
            <select id="f-sort" name="sort" defaultValue={f.sort} className="input">
              {CONTENT_SORTS.map((s) => (
                <option key={s} value={s}>
                  {SORT_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary">
            Apply filters
          </button>
          <Link href={base} className="btn btn-secondary">
            Clear filters
          </Link>
        </div>
      </form>

      {vm.error ? <ErrorBanner message={vm.error} retryHref={pageHref(vm, vm.page)} /> : null}

      {!vm.error ? (
        <>
          <section aria-label="Metric freshness and mode" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1">
              <Icon name="clock-alert" className="h-3.5 w-3.5 text-ink-2" />
              Metrics current as of {vm.metricsAsOf ?? "no sync yet"}
              {vm.metricsOutdated ? <Pill tone="stale">Outdated</Pill> : null}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1">
              Showing: <strong>Lifetime</strong> values
              <InfoTip label="About Lifetime vs Period">
                {DEFINITIONS.lifetime} Period values aren&apos;t available: Buffer only exposes each post&apos;s current lifetime counters, so BrandPulse reports lifetime
                performance of posts published in the selected range.
              </InfoTip>
            </span>
            <span className="text-xs text-ink-2">
              {vm.totalFiltered} of {vm.totalInRange} posts published {f.from} → {f.to}
            </span>
          </section>

          {vm.summaries.length ? (
            <div className="mb-4 grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
              {vm.summaries.map((s) => (
                <Card key={s.platform} labelledBy={`sum-${s.platform}`}>
                  <CardTitle id={`sum-${s.platform}`}>{s.label}</CardTitle>
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <dt className="text-xs text-ink-2">Posts published</dt>
                      <dd className="font-semibold tabular-nums">{s.posts}</dd>
                    </div>
                    <div>
                      <dt className="flex items-center text-xs text-ink-2">
                        Total views <InfoTip label={`About ${s.label} total views`}>{s.viewsNote}</InfoTip>
                      </dt>
                      <dd className="font-semibold tabular-nums">{s.views}</dd>
                    </div>
                    <div>
                      <dt className="flex items-center text-xs text-ink-2">
                        Total engagement <InfoTip label={`About ${s.label} total engagement`}>{s.engagementsNote}</InfoTip>
                      </dt>
                      <dd className="font-semibold tabular-nums">{s.engagements}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-2">Median reach per post</dt>
                      <dd className="font-semibold tabular-nums">{s.medianReach}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="flex items-center text-xs text-ink-2">
                        Median engagement rate
                        <InfoTip label={`About ${s.label} engagement rate`}>
                          {s.platform === "instagram" ? DEFINITIONS.erReach : DEFINITIONS.erViews} Definition id: {s.erDefinitionId}. Average of rates is not provided; the median per post is shown.
                        </InfoTip>
                      </dt>
                      <dd className="font-semibold tabular-nums">{s.medianEr}</dd>
                    </div>
                  </dl>
                  <div className="mt-3 grid gap-3">
                    {s.charts.map((c) => (
                      <TrendChart key={c.id} id={c.id} title={c.title} yLabel={c.yLabel} unit={c.unit} points={c.points} summary={c.summary} />
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          ) : null}

          <Card labelledBy="posts-table">
            <CardTitle id="posts-table">Published posts</CardTitle>
            {vm.sortNote ? <p className="mb-2 text-xs text-ink-2">{vm.sortNote}</p> : null}
            <details className="mb-3 text-sm">
              <summary className="link cursor-pointer">How ranking badges work</summary>
              <p className="mt-1 text-ink-2">{vm.rankingMethod}</p>
            </details>
            {vm.rows.length === 0 ? (
              <EmptyState
                title="No published posts found for this filter."
                action={
                  vm.filtersActive ? (
                    <Link href={base} className="btn btn-secondary">
                      Clear filters
                    </Link>
                  ) : undefined
                }
              />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="data-table w-full text-sm">
                    <caption className="sr-only">Published posts with lifetime metrics, engagement rate, provenance and ranking</caption>
                    <thead>
                      <tr>
                        <th scope="col">Post</th>
                        <th scope="col">Published</th>
                        <th scope="col">Views</th>
                        <th scope="col">Reach</th>
                        <th scope="col">Reactions</th>
                        <th scope="col">Comments</th>
                        <th scope="col">Shares</th>
                        <th scope="col">Saves</th>
                        <th scope="col">Eng. rate</th>
                        <th scope="col">Ranking</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vm.rows.map((r) => (
                        <tr key={r.postId}>
                          <td className="min-w-56 max-w-xs">
                            <p className="line-clamp-2 break-words">{r.preview || <span className="italic text-ink-2">No caption</span>}</p>
                            <p className="text-xs text-ink-2">
                              @{r.handle.replace(/^@/, "")} · {r.platformLabel}
                              {r.format ? ` · ${r.format}` : ""}
                            </p>
                            <details className="mt-1 text-xs">
                              <summary className="link cursor-pointer">Details</summary>
                              <div className="mt-1 space-y-1">
                                <p className="text-ink-2">{r.provenance}</p>
                                {r.observedAge ? <p className="text-ink-2">{r.observedAge} (lifetime counters grow with age)</p> : null}
                                {r.tags.length ? <p>Tags: {r.tags.join(", ")}</p> : null}
                                <ul className="grid grid-cols-2 gap-x-3">
                                  {r.extraMetrics.map((m) => (
                                    <li key={m.key} className="flex items-center justify-between gap-1">
                                      <span className="text-ink-2">{m.label}</span>
                                      <MetricCell cell={m} />
                                    </li>
                                  ))}
                                </ul>
                                {r.externalUrl ? (
                                  <a href={r.externalUrl} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-0.5">
                                    Open original post <Icon name="external" className="h-3 w-3" />
                                    <span className="sr-only">(opens in a new tab)</span>
                                  </a>
                                ) : null}
                              </div>
                            </details>
                          </td>
                          <td className="whitespace-nowrap text-xs">{r.published}</td>
                          {r.metrics.map((m) => (
                            <td key={m.key}>
                              <MetricCell cell={m} />
                            </td>
                          ))}
                          <td>
                            <ErCell cell={r.er} />
                          </td>
                          <td className="text-xs">
                            {r.rank ? (
                              <span className="inline-flex items-center">
                                <Pill tone={r.rank.kind === "best" ? "healthy" : r.rank.kind === "under" ? "warning" : "neutral"}>{r.rank.label}</Pill>
                                <InfoTip label="About this ranking" align="right">
                                  {r.rank.explanation}
                                  {"confidence" in r.rank ? ` Confidence: ${r.rank.confidence}.` : ""}
                                </InfoTip>
                              </span>
                            ) : (
                              <span className="text-ink-2">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {vm.pageCount > 1 ? (
                  <nav aria-label="Pagination" className="mt-3 flex items-center justify-between text-sm">
                    {vm.page > 1 ? (
                      <Link href={pageHref(vm, vm.page - 1)} className="btn btn-secondary">
                        Previous
                      </Link>
                    ) : (
                      <span />
                    )}
                    <span>
                      Page {vm.page} of {vm.pageCount}
                    </span>
                    {vm.page < vm.pageCount ? (
                      <Link href={pageHref(vm, vm.page + 1)} className="btn btn-secondary">
                        Next
                      </Link>
                    ) : (
                      <span />
                    )}
                  </nav>
                ) : null}
              </>
            )}
          </Card>
        </>
      ) : null}

      <Card labelledBy="audience-growth" className="mt-4">
        <CardTitle id="audience-growth">Audience growth</CardTitle>
        <AudienceUnavailable />
      </Card>
    </>
  );
}
