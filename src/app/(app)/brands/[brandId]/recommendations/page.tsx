import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/forms/ActionForm";
import { Card, CardTitle, PageHeader } from "@/components/ui/Card";
import { DEFINITIONS } from "@/components/ui/copy";
import { DemoBadge } from "@/components/ui/Demo";
import { Icon } from "@/components/ui/Icon";
import { InfoTip } from "@/components/ui/InfoTip";
import { Banner, EmptyState } from "@/components/ui/States";
import { Pill } from "@/components/ui/StatusBadge";
import { createExperimentAction, recommendationStatusAction, updateExperimentAction } from "@/server/actions/recommendations";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import type { Platform } from "@/domain/types";
import { oneOf, orNotFound, param, type SearchParams } from "@/server/queries/pages/guard";
import { loadRecommendations, REC_PRIORITY_FILTERS, REC_STATUS_FILTERS, type RecommendationCardVM } from "@/server/queries/pages/recommendations";

export const metadata: Metadata = { title: "Recommendations & experiments" };

const STATUS_FILTER_LABEL: Record<string, string> = { active: "Active (new, accepted, trying)", proposed: "New", accepted: "Accepted", in_experiment: "Trying", dismissed: "Dismissed", done: "Done", all: "All" };

function FactList({ title, facts }: { title: string; facts: { label: string; value: string }[] }) {
  if (facts.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-semibold text-ink-2">{title}</p>
      <dl className="mt-0.5 grid gap-x-3 text-xs sm:grid-cols-2">
        {facts.map((f) => (
          <div key={f.label} className="flex min-w-0 gap-1">
            <dt className="shrink-0 text-ink-2">{f.label}:</dt>
            <dd className="min-w-0 break-words">{f.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function RecCard({ c, brandId, canManage }: { c: RecommendationCardVM; brandId: string; canManage: boolean }) {
  const hidden = { brandId, recommendationId: c.id };
  return (
    <article aria-labelledby={`rec-${c.id}`} className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={c.priority === "high" ? "critical" : c.priority === "medium" ? "warning" : "neutral"}>Priority: {c.priority[0]!.toUpperCase() + c.priority.slice(1)}</Pill>
        <span className="inline-flex items-center">
          <Pill tone="accent">Confidence: {c.confidence[0]!.toUpperCase() + c.confidence.slice(1)}</Pill>
          <InfoTip label="About Confidence">{DEFINITIONS.confidence}</InfoTip>
        </span>
        <Pill>{c.statusLabel}</Pill>
        <span className="text-xs text-ink-2">
          {c.kindLabel}
          {c.account ? ` · ${c.account}` : ""} · updated {c.updated}
        </span>
        {c.isDemo ? <DemoBadge /> : null}
      </div>
      <h2 id={`rec-${c.id}`} className="sr-only">
        {c.kindLabel} recommendation
      </h2>

      <div lang={c.locale} className="mt-3 grid gap-3 lg:grid-cols-2">
        <section aria-label="Observed finding" className="rounded-md border border-line p-3">
          <p className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-ink-2">
            <Icon name="eye" className="h-3.5 w-3.5" /> Observed
          </p>
          <p className="font-medium">{c.finding}</p>
          <div className="mt-2 space-y-2">
            <FactList title="Comparison period" facts={c.periodFacts} />
            <FactList title="Sample size" facts={c.sampleFacts} />
            <FactList title="Supporting metrics" facts={c.otherFacts} />
            {c.posts.length ? (
              <div>
                <p className="text-xs font-semibold text-ink-2">Linked posts ({c.posts.length})</p>
                <ul className="mt-0.5 space-y-0.5 text-xs">
                  {c.posts.slice(0, 12).map((p, i) => (
                    <li key={`${p.postId}-${i}`}>
                      {p.url ? (
                        <a href={p.url} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-0.5">
                          {p.group}
                          {p.published ? ` · ${p.published}` : ""}
                          {p.value ? ` · ${p.value}` : ""}
                          <Icon name="external" className="h-3 w-3" />
                          <span className="sr-only">(opens in a new tab)</span>
                        </a>
                      ) : (
                        <span>
                          {p.group}
                          {p.published ? ` · ${p.published}` : ""}
                          {p.value ? ` · ${p.value}` : ""}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </section>
        <section aria-label="Hypothesis" className="rounded-md border border-dashed border-line-strong bg-canvas p-3">
          <p className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-ink-2">
            <Icon name="lightbulb" className="h-3.5 w-3.5" /> Hypothesis — our interpretation, not a measured fact
          </p>
          <p className="italic">{c.interpretation}</p>
          <p className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-ink-2">Suggested action</p>
          <p>{c.action}</p>
          <p className="mt-2 text-xs text-ink-2">
            Success metric: {c.successMetric} · Evaluation window: {c.evaluationWindowDays} days
          </p>
        </section>
      </div>

      {c.experiment ? (
        <p className="mt-3 text-sm">
          <Icon name="flask" className="mr-1 inline h-4 w-4 text-accent" />
          {c.experiment.status === "running" ? "Trying since" : "Experiment"} {c.experiment.startDate ?? "—"} → {c.experiment.endDate ?? "—"} ({c.experiment.status})
        </p>
      ) : null}

      {canManage && c.status !== "superseded" ? (
        <div className="mt-3 flex flex-wrap items-start gap-2 border-t border-line pt-3">
          {c.status === "proposed" ? <ActionForm action={recommendationStatusAction} hidden={{ ...hidden, status: "accepted" }} submitLabel="Accept" variant="secondary" inline /> : null}
          {c.status === "proposed" || c.status === "accepted" ? <ActionForm action={recommendationStatusAction} hidden={{ ...hidden, status: "dismissed" }} submitLabel="Dismiss" variant="secondary" inline /> : null}
          {c.status === "accepted" ? <ActionForm action={recommendationStatusAction} hidden={{ ...hidden, status: "done" }} submitLabel="Mark done" variant="secondary" inline /> : null}
          {c.status === "dismissed" || c.status === "done" ? <ActionForm action={recommendationStatusAction} hidden={{ ...hidden, status: "proposed" }} submitLabel="Restore" variant="secondary" inline /> : null}
          {c.canStartExperiment ? (
            <details className="w-full">
              <summary className="link cursor-pointer text-sm">Mark as trying (create experiment)</summary>
              <ActionForm action={createExperimentAction} hidden={hidden} submitLabel="Start experiment" className="mt-2 max-w-xl">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <label htmlFor={`es-${c.id}`} className="label text-xs">
                      Start date
                    </label>
                    <input id={`es-${c.id}`} name="startDate" type="date" required defaultValue={c.defaultStart} className="input" />
                  </div>
                  <div>
                    <label htmlFor={`ee-${c.id}`} className="label text-xs">
                      End date
                    </label>
                    <input id={`ee-${c.id}`} name="endDate" type="date" required defaultValue={c.defaultEnd} className="input" />
                  </div>
                </div>
                <div>
                  <label htmlFor={`eh-${c.id}`} className="label text-xs">
                    Hypothesis (optional; defaults to the interpretation above)
                  </label>
                  <textarea id={`eh-${c.id}`} name="hypothesis" rows={2} maxLength={2000} className="input" />
                </div>
              </ActionForm>
            </details>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export default async function RecommendationsPage({ params, searchParams }: { params: Promise<{ brandId: string }>; searchParams: Promise<SearchParams> }) {
  const { brandId } = await params;
  const sp = await searchParams;
  const user = await requireUser("page");
  const filters = {
    status: oneOf(param(sp, "status"), REC_STATUS_FILTERS, "active"),
    priority: oneOf(param(sp, "priority"), REC_PRIORITY_FILTERS, "all"),
    platform: oneOf(param(sp, "platform"), ["all", "instagram", "tiktok", "youtube", "other"] as const, "all") as Platform | "all",
  };
  const vm = await orNotFound(loadRecommendations(getDb(), user, brandId, new Date(), filters));
  const base = `/brands/${vm.brand.id}/recommendations`;

  return (
    <>
      <PageHeader
        title="Recommendations & experiments"
        subtitle={`Findings from this brand's own data, with the evidence behind each one. Recommendation text uses the brand's report language (${vm.brand.reportLocale}).`}
      />
      <Banner tone="info">
        {vm.lastGenerated ? `Recommendations were last generated on ${vm.lastGenerated}` : "Recommendations haven't been generated yet"}
        {vm.dataAsOf ? ` using data as of ${vm.dataAsOf}.` : "."} They refresh periodically, not in real time.
      </Banner>
      {!vm.canManage ? <p className="mb-3 text-sm text-ink-2">You have view-only access. Managers and owners can accept, dismiss or track recommendations.</p> : null}

      <form method="get" action={base} className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface p-3" aria-label="Recommendation filters">
        <div>
          <label htmlFor="r-status" className="label text-xs">
            Status
          </label>
          <select id="r-status" name="status" defaultValue={vm.filters.status} className="input">
            {REC_STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {STATUS_FILTER_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="r-priority" className="label text-xs">
            Priority
          </label>
          <select id="r-priority" name="priority" defaultValue={vm.filters.priority} className="input">
            {REC_PRIORITY_FILTERS.map((p) => (
              <option key={p} value={p}>
                {p === "all" ? "All" : p[0]!.toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="r-platform" className="label text-xs">
            Platform
          </label>
          <select id="r-platform" name="platform" defaultValue={vm.filters.platform} className="input">
            <option value="all">All</option>
            {vm.platforms.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn-primary">
          Apply
        </button>
        <Link href={base} className="btn btn-secondary">
          Reset
        </Link>
      </form>

      {vm.cards.length === 0 ? (
        vm.filters.status === "active" && vm.filters.priority === "all" && vm.filters.platform === "all" ? (
          <EmptyState title="Not enough data yet to generate recommendations for this brand.">We typically need {vm.emptyThreshold}.</EmptyState>
        ) : (
          <EmptyState title="No recommendations match these filters." />
        )
      ) : (
        <ul className="space-y-3">
          {vm.cards.map((c) => (
            <li key={c.id}>
              <RecCard c={c} brandId={vm.brand.id} canManage={vm.canManage} />
            </li>
          ))}
        </ul>
      )}

      <Card labelledBy="experiments" className="mt-6">
        <CardTitle id="experiments">Experiments</CardTitle>
        {vm.experiments.length === 0 ? (
          <p className="text-sm text-ink-2">No experiments yet. Use &ldquo;Mark as trying&rdquo; on a recommendation to track it.</p>
        ) : (
          <ul className="space-y-3">
            {vm.experiments.map((e) => (
              <li key={e.id} className="rounded-md border border-line p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={e.status === "running" ? "accent" : e.status === "completed" ? "healthy" : "neutral"}>{e.status[0]!.toUpperCase() + e.status.slice(1)}</Pill>
                  <span className="text-xs text-ink-2">
                    {e.startDate ?? "—"} → {e.endDate ?? "—"} · created {e.created}
                  </span>
                </div>
                <p className="mt-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink-2">Hypothesis: </span>
                  <span className="italic">{e.hypothesis}</span>
                </p>
                <p className="mt-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink-2">Action: </span>
                  {e.action}
                </p>
                <p className="mt-1 text-xs text-ink-2">Success metric: {e.successMetric}</p>
                {e.resultSummary ? <p className="mt-1">Result: {e.resultSummary}</p> : null}
                {vm.canManage && !e.finished ? (
                  <details className="mt-2">
                    <summary className="link cursor-pointer text-sm">Update experiment</summary>
                    <ActionForm action={updateExperimentAction} hidden={{ brandId: vm.brand.id, experimentId: e.id }} submitLabel="Save" className="mt-2 max-w-xl">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div>
                          <label htmlFor={`xs-${e.id}`} className="label text-xs">
                            Status
                          </label>
                          <select id={`xs-${e.id}`} name="status" defaultValue={e.status} className="input">
                            <option value="planned">Planned</option>
                            <option value="running">Running</option>
                            <option value="completed">Completed</option>
                            <option value="abandoned">Abandoned</option>
                          </select>
                        </div>
                        <div>
                          <label htmlFor={`xe-${e.id}`} className="label text-xs">
                            End date
                          </label>
                          <input id={`xe-${e.id}`} name="endDate" type="date" defaultValue={e.endDate ?? ""} className="input" />
                        </div>
                      </div>
                      <div>
                        <label htmlFor={`xr-${e.id}`} className="label text-xs">
                          Result summary
                        </label>
                        <textarea id={`xr-${e.id}`} name="resultSummary" rows={2} maxLength={4000} defaultValue={e.resultSummary ?? ""} className="input" />
                      </div>
                    </ActionForm>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
