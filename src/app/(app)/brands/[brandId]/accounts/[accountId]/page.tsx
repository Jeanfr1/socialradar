import type { Metadata } from "next";
import Link from "next/link";
import { ErCell, MetricCell } from "@/components/content/MetricCell";
import { SchedulingCard } from "@/components/health/SchedulingCard";
import { CoverageSlotsTimeline, PostingScheduleGrid } from "@/components/health/ScheduleViews";
import { Card, CardTitle, PageHeader, Stat } from "@/components/ui/Card";
import { DEFINITIONS } from "@/components/ui/copy";
import { DemoBadge } from "@/components/ui/Demo";
import { Freshness } from "@/components/ui/Freshness";
import { Icon } from "@/components/ui/Icon";
import { InfoTip } from "@/components/ui/InfoTip";
import { AudienceUnavailable, UnavailableState } from "@/components/ui/States";
import { Pill } from "@/components/ui/StatusBadge";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { loadAccountDetail, POST_STATUS_FILTERS } from "@/server/queries/pages/account-detail";
import { oneOf, orNotFound, param, type SearchParams } from "@/server/queries/pages/guard";

export const metadata: Metadata = { title: "Account detail" };

const STATE_TONE = { Active: "healthy", "Queue paused": "neutral", Disconnected: "critical", Locked: "neutral" } as const;

export default async function AccountDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ brandId: string; accountId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { brandId, accountId } = await params;
  const sp = await searchParams;
  const user = await requireUser("page");
  const status = oneOf(param(sp, "status"), POST_STATUS_FILTERS, "all");
  const vm = await orNotFound(loadAccountDetail(getDb(), user, brandId, accountId, new Date(), { status }));
  const base = `/brands/${vm.brand.id}/accounts/${vm.account.id}`;
  const h = vm.health;

  return (
    <>
      <PageHeader
        title={`@${vm.account.handle.replace(/^@/, "")}`}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            {vm.account.displayName ? <span>{vm.account.displayName}</span> : null}
            <span>{vm.account.platformLabel}</span>
            <span>· Connection: {vm.account.connectionLabel}</span>
            {vm.account.isDemo ? <DemoBadge /> : null}
          </span>
        }
        meta={
          <>
            <Pill tone={STATE_TONE[vm.connectionState]}>
              <Icon name={vm.connectionState === "Disconnected" ? "unlink" : vm.connectionState === "Locked" ? "lock" : vm.connectionState === "Queue paused" ? "pause-circle" : "check-circle"} className="h-3 w-3" />
              {vm.connectionState}
            </Pill>
            <span>Channel timezone: {vm.account.providerTimezone ?? "Unknown"}</span>
            <Freshness vm={vm.freshness} />
          </>
        }
        actions={
          <>
            {vm.account.externalUrl ? (
              <a href={vm.account.externalUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary">
                Open profile <Icon name="external" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : null}
            {vm.canManage ? (
              <Link href={`/settings/brands/${vm.brand.id}#cadence-${vm.account.id}`} className="btn btn-secondary">
                Edit cadence
              </Link>
            ) : null}
          </>
        }
      />

      {vm.account.removed || !h ? (
        <UnavailableState title="This channel is no longer returned by Buffer">
          Its connection was removed or Buffer no longer lists the channel. Historical posts and metrics are kept below; queue coverage can&apos;t be
          computed.
        </UnavailableState>
      ) : (
        <SchedulingCard vm={h} headingId="scheduling-math" />
      )}

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card labelledBy="posting-schedule">
          <CardTitle id="posting-schedule">Posting schedule</CardTitle>
          <p className="mb-2 text-xs text-ink-2">Buffer posting schedule (channel timezone {vm.account.providerTimezone ?? "unknown"}).</p>
          <PostingScheduleGrid days={vm.providerSchedule} caption="Buffer posting slots per weekday" />
          {vm.cadenceSchedule ? (
            <>
              <p className="mb-2 mt-4 text-xs text-ink-2">BrandPulse custom cadence used for coverage:</p>
              <PostingScheduleGrid days={vm.cadenceSchedule} caption="Custom cadence slots per weekday" />
            </>
          ) : null}
          {vm.cadenceSummary.length ? (
            <dl className="mt-4 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
              {vm.cadenceSummary.map((c) => (
                <div key={c.label} className="flex gap-1">
                  <dt className="text-ink-2">{c.label}:</dt>
                  <dd>{c.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </Card>

        <Card labelledBy="failures">
          <CardTitle id="failures">Failures and overdue posts</CardTitle>
          {!h || (h.recentErrors.length === 0 && h.overdue.length === 0) ? (
            <p className="text-sm text-ink-2">No failed publications in the last 14 days and no overdue scheduled posts.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {h.recentErrors.map((e) => (
                <li key={e.postId} className="rounded-md border border-critical/30 bg-critical/5 p-2">
                  <p className="font-medium text-critical">This post failed to publish{e.due ? ` (due ${e.due})` : ""}.</p>
                  <details className="mt-1">
                    <summary className="link cursor-pointer text-xs">Details</summary>
                    <p className="mt-1 whitespace-pre-wrap break-words text-ink">Buffer reported: &ldquo;{e.message}&rdquo;</p>
                  </details>
                  {e.externalUrl ? (
                    <a href={e.externalUrl} target="_blank" rel="noopener noreferrer" className="link text-xs">
                      Open post <span className="sr-only">(opens in a new tab)</span>
                    </a>
                  ) : null}
                </li>
              ))}
              {h.overdue.map((o) => (
                <li key={o.postId} className="rounded-md border border-warning/30 bg-warning/5 p-2">
                  <p className="font-medium text-warning">Scheduled post overdue</p>
                  <p className="text-ink-2">Due {o.due} and still not sent. Check it in Buffer.</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {h ? (
        <Card labelledBy="slots" className="mt-4">
          <CardTitle id="slots">Coverage slots</CardTitle>
          <p className="mb-3 text-xs text-ink-2">
            Expected slots from now through the horizon, in {h.cadenceTimezone} ({h.cadenceZoneLabel}). Hatched days contain at least one uncovered slot.
          </p>
          {h.scheduling.unavailable ? <p className="text-sm text-ink-2">{h.scheduling.unavailable}</p> : <CoverageSlotsTimeline days={vm.slotDays} />}
        </Card>
      ) : null}

      <Card labelledBy="recent-posts" className="mt-4">
        <CardTitle
          id="recent-posts"
          actions={
            <nav aria-label="Post status filter" className="flex flex-wrap gap-1 text-sm">
              {POST_STATUS_FILTERS.map((f) => (
                <Link key={f} href={`${base}?status=${f}`} aria-current={f === vm.statusFilter ? "true" : undefined} className={`rounded-full border px-2.5 py-1 ${f === vm.statusFilter ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line text-ink-2"}`}>
                  {f === "all" ? "All" : f === "draft" ? "Draft / approval" : f[0]!.toUpperCase() + f.slice(1)}
                </Link>
              ))}
            </nav>
          }
        >
          Recent posts
        </CardTitle>
        <p className="mb-2 text-xs text-ink-2">Last 28 days plus everything scheduled ahead. Metrics are lifetime totals as of the last provider refresh.</p>
        {vm.recentPosts.length === 0 ? (
          <p className="text-sm text-ink-2">No posts match this filter.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full text-sm">
              <caption className="sr-only">Recent posts for this account</caption>
              <thead>
                <tr>
                  <th scope="col">Post</th>
                  <th scope="col">Status</th>
                  <th scope="col">Due / sent</th>
                  <th scope="col">Views</th>
                  <th scope="col">Reach</th>
                  <th scope="col">Reactions</th>
                  <th scope="col">Comments</th>
                  <th scope="col">Shares</th>
                  <th scope="col">Saves</th>
                  <th scope="col">
                    <span className="inline-flex items-center">
                      Eng. rate
                      <InfoTip label="About Engagement rate" align="right">
                        {DEFINITIONS.erReach} {DEFINITIONS.erViews}
                      </InfoTip>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {vm.recentPosts.map((p) => (
                  <tr key={p.id}>
                    <td className="max-w-xs">
                      <p className="line-clamp-2 break-words">{p.preview || <span className="italic text-ink-2">No caption</span>}</p>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
                        {p.format ? <span>{p.format}</span> : null}
                        {p.externalUrl ? (
                          <a href={p.externalUrl} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-0.5">
                            Original <Icon name="external" className="h-3 w-3" />
                            <span className="sr-only">(opens in a new tab)</span>
                          </a>
                        ) : null}
                      </div>
                      {p.errorMessage ? (
                        <details className="mt-1 text-xs">
                          <summary className="cursor-pointer text-critical">Error details</summary>
                          <p className="whitespace-pre-wrap break-words">Buffer reported: &ldquo;{p.errorMessage}&rdquo;</p>
                        </details>
                      ) : null}
                    </td>
                    <td>
                      <Pill tone={p.status === "error" ? "critical" : p.status === "sent" ? "healthy" : "neutral"}>{p.statusLabel}</Pill>
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      {p.sent ? <div>Sent {p.sent}</div> : null}
                      {p.due && !p.sent ? <div>Due {p.due}</div> : null}
                      {!p.due && !p.sent ? <div className="italic text-ink-2">Time not confirmed</div> : null}
                      {p.metricsAsOf ? <div className="text-ink-2">Metrics as of {p.metricsAsOf}</div> : null}
                    </td>
                    {p.metrics ? (
                      p.metrics.map((m) => (
                        <td key={m.key}>
                          <MetricCell cell={m} />
                        </td>
                      ))
                    ) : (
                      <td colSpan={6} className="text-xs italic text-ink-2">
                        {p.status === "sent" ? "Published more than 56 days ago — see Content" : "Not published yet"}
                      </td>
                    )}
                    <td>{p.er ? <ErCell cell={p.er} /> : <span className="text-xs text-ink-2">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card labelledBy="perf-summary">
          <CardTitle id="perf-summary">Performance summary (28 days)</CardTitle>
          <dl className="grid grid-cols-2 gap-2">
            <Stat label="Posts published" value={vm.performance.posts} />
            <Stat label="Median views per post" value={vm.performance.medianViews} />
            <Stat label="Median reach per post" value={vm.performance.medianReach} />
            <Stat label={<span className="inline-flex items-center">Median engagement rate<InfoTip label="About Engagement rate">{`Definition id ${vm.performance.erDefinitionId}.`}</InfoTip></span>} value={vm.performance.medianEr} />
          </dl>
          <div className="mt-3 text-sm">
            <p className="flex items-center font-medium">
              Top post
              <InfoTip label="How posts are ranked">{vm.performance.topPostNote}</InfoTip>
            </p>
            {vm.performance.topPost ? (
              <>
                <p>{vm.performance.topPost.title}</p>
                <p className="text-xs text-ink-2">{vm.performance.topPost.explanation}</p>
                {vm.performance.topPost.externalUrl ? (
                  <a href={vm.performance.topPost.externalUrl} target="_blank" rel="noopener noreferrer" className="link text-xs">
                    Open original post <span className="sr-only">(opens in a new tab)</span>
                  </a>
                ) : null}
              </>
            ) : (
              <p className="text-ink-2">No post clearly outperformed comparable posts (needs at least 5 comparable posts observed ≥72h after publishing).</p>
            )}
          </div>
        </Card>
        <Card labelledBy="audience">
          <CardTitle id="audience">Audience growth</CardTitle>
          <AudienceUnavailable />
        </Card>
      </div>

      <Card labelledBy="availability" className="mt-4">
        <CardTitle id="availability">Metric availability for {vm.account.platformLabel}</CardTitle>
        <p className="mb-2 text-xs text-ink-2">What Buffer provides for this platform, and what was actually observed on this account&apos;s posts in the last 28 days.</p>
        <div className="overflow-x-auto">
          <table className="data-table w-full text-sm">
            <caption className="sr-only">Metric availability matrix</caption>
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Availability</th>
                <th scope="col">Semantics</th>
                <th scope="col">Observed (28 days)</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {vm.availability.map((m) => (
                <tr key={m.key}>
                  <th scope="row" className="font-medium">
                    {m.label}
                    <div className="text-xs font-normal text-ink-2">{m.description}</div>
                  </th>
                  <td>
                    {m.capability === "supported" ? (
                      <Pill tone="healthy">
                        <Icon name="check-circle" className="h-3 w-3" /> Supported
                      </Pill>
                    ) : m.capability === "unsupported" ? (
                      <Pill>
                        <Icon name="circle-slash" className="h-3 w-3" /> Unsupported
                      </Pill>
                    ) : (
                      <Pill tone="warning">Requires direct platform connection</Pill>
                    )}
                  </td>
                  <td className="text-xs">{m.semantics}</td>
                  <td className="text-xs tabular-nums">{m.observed}</td>
                  <td className="max-w-sm text-xs text-ink-2">{m.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
