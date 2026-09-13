import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/forms/ActionForm";
import { Card, CardTitle, PageHeader } from "@/components/ui/Card";
import { DemoBadge } from "@/components/ui/Demo";
import { Icon } from "@/components/ui/Icon";
import { Banner, EmptyState, ErrorBanner, PermissionMessage } from "@/components/ui/States";
import { Pill } from "@/components/ui/StatusBadge";
import {
  createConnectionAction,
  ignoreAccountAction,
  mapAccountAction,
  rediscoverChannelsAction,
  removeConnectionAction,
  revalidateConnectionAction,
  rotateCredentialAction,
} from "@/server/actions/settings";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { oneOf, param, type SearchParams } from "@/server/queries/pages/guard";
import { loadConnectionsSettings, type ConnectionsSettingsVM } from "@/server/queries/pages/settings";

export const metadata: Metadata = { title: "Connections" };

const FILTERS = ["all", "unmapped", "mapped", "ignored"] as const;

function KeyInput({ id }: { id: string }) {
  return (
    <div>
      <label htmlFor={id} className="label">
        Buffer API key
      </label>
      <input id={id} name="apiKey" type="password" autoComplete="off" autoCapitalize="off" spellCheck={false} required minLength={16} className="input font-mono" />
      <p className="mt-1 text-xs text-ink-2">
        Sent only to the server, validated with Buffer, then stored encrypted. It is never shown again — only a masked hint.
      </p>
    </div>
  );
}

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const user = await requireUser("page");
  if (!user.isWorkspaceAdmin) {
    return <PermissionMessage title="Connections are managed by workspace administrators">Only workspace administrators can add, rotate or remove Buffer API keys and map channels to brands.</PermissionMessage>;
  }
  const filter = oneOf(param(sp, "filter"), FILTERS, "all");
  let vm: ConnectionsSettingsVM;
  try {
    vm = await loadConnectionsSettings(getDb(), user, new Date(), filter);
  } catch {
    return (
      <>
        <PageHeader title="Connections" />
        <ErrorBanner message="We couldn't load connections." retryHref="/settings/connections" />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Connections" subtitle="Buffer API keys, discovered channels and channel-to-brand mapping. BrandPulse only reads from Buffer; it never publishes, edits or deletes posts." />

      <Card labelledBy="add-conn" className="mb-4">
        <CardTitle id="add-conn">Add Buffer connection</CardTitle>
        <ActionForm action={createConnectionAction} submitLabel="Validate and save" pendingLabel="Validating with Buffer…" className="max-w-xl">
          <div>
            <label htmlFor="conn-label" className="label">
              Label <span className="font-normal text-ink-2">(optional)</span>
            </label>
            <input id="conn-label" name="label" maxLength={80} className="input" placeholder="Defaults to the Buffer account name" />
          </div>
          <KeyInput id="conn-key" />
        </ActionForm>
      </Card>

      <section aria-labelledby="conn-list" className="mb-6">
        <h2 id="conn-list" className="mb-3 text-lg font-semibold">
          Connections
        </h2>
        {vm.connections.length === 0 ? (
          <EmptyState title="No Buffer connections yet.">Add a Buffer connection above to start discovering your channels.</EmptyState>
        ) : (
          <ul className="grid gap-3 xl:grid-cols-2">
            {vm.connections.map((c) => (
              <li key={c.id} className="rounded-lg border border-line bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold">{c.label}</h3>
                  <Pill tone={c.status === "active" ? "healthy" : c.status === "pending" ? "neutral" : "critical"}>{c.status}</Pill>
                  {c.keyHint ? <code className="rounded bg-canvas px-1.5 py-0.5 text-xs">{c.keyHint}</code> : null}
                  {c.isDemo ? <DemoBadge /> : null}
                </div>
                <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 text-sm sm:grid-cols-2">
                  <div className="flex gap-1">
                    <dt className="text-ink-2">Buffer account:</dt>
                    <dd>{c.accountName ?? "—"}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt className="text-ink-2">Channels:</dt>
                    <dd>
                      {c.accountCount} ({c.mappedCount} mapped)
                    </dd>
                  </div>
                  <div className="flex gap-1">
                    <dt className="text-ink-2">Added:</dt>
                    <dd>{c.added}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt className="text-ink-2">Last validated:</dt>
                    <dd>{c.lastValidated}</dd>
                  </div>
                  <div className="flex gap-1 sm:col-span-2">
                    <dt className="text-ink-2">Last successful sync:</dt>
                    <dd>{c.lastSync}</dd>
                  </div>
                  {c.rotated ? (
                    <div className="flex gap-1">
                      <dt className="text-ink-2">Key rotated:</dt>
                      <dd>{c.rotated}</dd>
                    </div>
                  ) : null}
                </dl>
                {c.status === "invalid" || c.status === "revoked" ? (
                  <p className="mt-2 rounded-md border border-critical/40 bg-critical/5 p-2 text-sm">This connection can&apos;t reach Buffer. The API key may have been revoked. Re-enter the key below.</p>
                ) : null}
                {c.lastError ? <p className="mt-2 break-words text-xs text-ink-2">Last error ({c.failures} consecutive failures): {c.lastError}</p> : null}
                {c.discoveryStale ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-stale/40 bg-[#fdf6e3] p-2 text-sm">
                    <span>Channels last discovered: {c.lastDiscovered}.</span>
                    <ActionForm action={rediscoverChannelsAction} hidden={{ connectionId: c.id }} submitLabel="Re-discover now" variant="secondary" inline />
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-ink-2">Channels last discovered {c.lastDiscovered}.</p>
                )}
                <div className="mt-3 flex flex-wrap items-start gap-2 border-t border-line pt-3">
                  <ActionForm action={revalidateConnectionAction} hidden={{ connectionId: c.id }} submitLabel="Re-validate key" pendingLabel="Checking…" variant="secondary" inline />
                  {!c.discoveryStale ? <ActionForm action={rediscoverChannelsAction} hidden={{ connectionId: c.id }} submitLabel="Re-discover channels" variant="secondary" inline /> : null}
                </div>
                <details className="mt-2">
                  <summary className="link cursor-pointer text-sm">Rotate / re-enter key</summary>
                  <ActionForm action={rotateCredentialAction} hidden={{ connectionId: c.id }} submitLabel="Validate and replace key" pendingLabel="Validating with Buffer…" className="mt-2 max-w-md">
                    <KeyInput id={`rotate-${c.id}`} />
                    <p className="text-xs text-ink-2">The new key must belong to the same Buffer account.</p>
                  </ActionForm>
                </details>
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-critical underline">Remove connection</summary>
                  <ActionForm action={removeConnectionAction} hidden={{ connectionId: c.id }} submitLabel="Remove connection" variant="danger" className="mt-2">
                    <label className="flex items-start gap-2 text-sm">
                      <input type="checkbox" name="confirm" required className="mt-1 h-4 w-4" />
                      <span>I understand the stored key is wiped and its channels stop syncing. Historical posts, metrics and reports are kept.</span>
                    </label>
                  </ActionForm>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="channels">
        <h2 id="channels" className="mb-1 text-lg font-semibold">
          Discovered channels
        </h2>
        <p className="mb-3 text-sm text-ink-2">Unmapped channels are excluded from every dashboard until they are mapped to a brand. You can map to brands where you are a manager or owner.</p>
        <nav aria-label="Channel mapping filter" className="mb-3 flex flex-wrap gap-1 text-sm">
          {FILTERS.map((f) => (
            <Link key={f} href={`/settings/connections?filter=${f}`} aria-current={vm.filter === f ? "true" : undefined} className={`rounded-full border px-3 py-1 ${vm.filter === f ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line text-ink-2"}`}>
              {f[0]!.toUpperCase() + f.slice(1)} ({vm.counts[f]})
            </Link>
          ))}
        </nav>
        {vm.counts.unmapped > 0 ? (
          <Banner tone="warning">
            {vm.counts.unmapped} {vm.counts.unmapped === 1 ? "channel is" : "channels are"} not mapped to a brand and not monitored.
          </Banner>
        ) : null}
        {vm.brandOptions.length === 0 ? <Banner tone="info">You are not a manager of any brand yet. Create a brand in Settings → Brands first (you become its owner).</Banner> : null}
        {vm.channels.length === 0 ? (
          <EmptyState title="No channels in this view." />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="data-table w-full text-sm">
              <caption className="sr-only">Discovered Buffer channels and their brand mapping</caption>
              <thead>
                <tr>
                  <th scope="col">Channel</th>
                  <th scope="col">Connection</th>
                  <th scope="col">Status</th>
                  <th scope="col">Mapping</th>
                  <th scope="col">Brand</th>
                  <th scope="col">Ignore</th>
                </tr>
              </thead>
              <tbody>
                {vm.channels.map((ch) => (
                  <tr key={ch.id}>
                    <th scope="row" className="font-medium">
                      @{ch.handle.replace(/^@/, "")}
                      <div className="text-xs font-normal text-ink-2">
                        {ch.platformLabel}
                        {ch.displayName ? ` · ${ch.displayName}` : ""}
                        {ch.timezone ? ` · ${ch.timezone}` : ""}
                      </div>
                      {ch.externalUrl ? (
                        <a href={ch.externalUrl} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-0.5 text-xs font-normal">
                          Profile <Icon name="external" className="h-3 w-3" />
                          <span className="sr-only">(opens in a new tab)</span>
                        </a>
                      ) : null}
                    </th>
                    <td className="text-xs">{vm.connections.find((c) => c.id === ch.connectionId)?.label ?? "—"}</td>
                    <td>
                      <Pill tone={ch.state === "Active" ? "healthy" : ch.state === "Disconnected" ? "critical" : "neutral"}>{ch.state}</Pill>
                      {ch.isDemo ? <DemoBadge /> : null}
                    </td>
                    <td>
                      <Pill tone={ch.mappingStatus === "mapped" ? "accent" : ch.mappingStatus === "unmapped" ? "warning" : "neutral"}>{ch.mappingStatus[0]!.toUpperCase() + ch.mappingStatus.slice(1)}</Pill>
                    </td>
                    <td className="min-w-64">
                      {ch.canChange && ch.mappingStatus !== "ignored" ? (
                        <ActionForm action={mapAccountAction} hidden={{ accountId: ch.id }} submitLabel="Save" variant="secondary" inline>
                          <div>
                            <label htmlFor={`map-${ch.id}`} className="sr-only">
                              Brand for @{ch.handle}
                            </label>
                            <select id={`map-${ch.id}`} name="brandId" defaultValue={ch.brandId ?? ""} className="input">
                              <option value="">Not mapped</option>
                              {vm.brandOptions.map((b) => (
                                <option key={b.id} value={b.id}>
                                  {b.name}
                                  {b.isDemo ? " (Demo)" : ""}
                                </option>
                              ))}
                            </select>
                          </div>
                        </ActionForm>
                      ) : (
                        <span className="text-xs text-ink-2">{ch.brandName ?? (ch.mappingStatus === "ignored" ? "Ignored" : "—")}</span>
                      )}
                    </td>
                    <td>
                      {ch.canChange ? (
                        <ActionForm action={ignoreAccountAction} hidden={{ accountId: ch.id, ignored: ch.mappingStatus === "ignored" ? "false" : "true" }} submitLabel={ch.mappingStatus === "ignored" ? "Restore" : "Ignore"} variant="secondary" inline />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
