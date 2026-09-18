import type { Metadata } from "next";
import { Card, CardTitle, PageHeader } from "@/components/ui/Card";
import { DemoBadge } from "@/components/ui/Demo";
import { Banner, ErrorBanner, PermissionMessage } from "@/components/ui/States";
import { Pill } from "@/components/ui/StatusBadge";
import { requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { loadSystemHealth, type SystemHealthVM } from "@/server/queries/pages/settings";

export const metadata: Metadata = { title: "Saúde do sistema" };

export default async function SystemPage() {
  const user = await requireUser("page");
  if (!user.isWorkspaceAdmin) return <PermissionMessage title="A saúde do sistema é visível apenas para administradores do workspace" />;
  let vm: SystemHealthVM;
  try {
    vm = await loadSystemHealth(getDb(), user, new Date());
  } catch {
    return (
      <>
        <PageHeader title="Saúde do sistema" />
        <ErrorBanner message="We couldn't load system health." retryHref="/settings/system" />
      </>
    );
  }
  const online = vm.workers.filter((w) => w.online).length;
  return (
    <>
      <PageHeader title="Saúde do sistema" subtitle="Sincronizações, fila de tarefas e cota do Buffer. Horários em UTC." />
      {online === 0 ? <Banner tone="error" role="alert">Nenhum processo de sincronização contínuo ativo. Em produção a atualização roda uma vez por dia pelo agendador da Vercel.</Banner> : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card labelledBy="workers">
          <CardTitle id="workers">Workers</CardTitle>
          {vm.workers.length === 0 ? (
            <p className="text-sm text-ink-2">Nenhum processo contínuo registrado (normal quando a atualização roda pelo agendador diário).</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table w-full text-sm">
                <caption className="sr-only">Processos de sincronização</caption>
                <thead>
                  <tr>
                    <th scope="col">Processo</th>
                    <th scope="col">Situação</th>
                    <th scope="col">Visto por último</th>
                    <th scope="col">Tarefas</th>
                  </tr>
                </thead>
                <tbody>
                  {vm.workers.map((w) => (
                    <tr key={w.id}>
                      <th scope="row" className="font-mono text-xs font-normal">
                        {w.id}
                        <div className="text-ink-2">started {w.started}</div>
                      </th>
                      <td>
                        <Pill tone={w.online ? "healthy" : "critical"}>{w.online ? "Online" : "Offline"}</Pill>
                      </td>
                      <td className="text-xs">{w.lastSeen}</td>
                      <td className="text-xs">
                        {w.jobsProcessed} processed{w.lastJobKind ? ` · last ${w.lastJobKind}` : ""}
                        {w.lastError ? <div className="break-words text-critical">Last error: {w.lastError}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card labelledBy="jobs">
          <CardTitle id="jobs">Fila de tarefas</CardTitle>
          {vm.jobCounts.length === 0 ? (
            <p className="text-sm text-ink-2">Nenhuma tarefa registrada.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table w-full text-sm">
                <caption className="sr-only">Tarefas por tipo e situação</caption>
                <thead>
                  <tr>
                    <th scope="col">Kind</th>
                    <th scope="col">Queued</th>
                    <th scope="col">Running</th>
                    <th scope="col">Succeeded</th>
                    <th scope="col">Failed</th>
                    <th scope="col">Dead</th>
                  </tr>
                </thead>
                <tbody>
                  {vm.jobCounts.map((j) => (
                    <tr key={j.kind}>
                      <th scope="row" className="font-mono text-xs font-normal">
                        {j.kind}
                      </th>
                      <td className="tabular-nums">{j.queued}</td>
                      <td className="tabular-nums">{j.running}</td>
                      <td className="tabular-nums">{j.succeeded}</td>
                      <td className={`tabular-nums ${j.failed ? "text-warning" : ""}`}>{j.failed}</td>
                      <td className={`tabular-nums ${j.dead ? "font-semibold text-critical" : ""}`}>{j.dead}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {vm.failedJobs.length ? (
            <details className="mt-3 text-sm">
              <summary className="link cursor-pointer">Recent failed jobs ({vm.failedJobs.length})</summary>
              <ul className="mt-2 space-y-1 text-xs">
                {vm.failedJobs.map((j) => (
                  <li key={j.id} className="break-words">
                    <span className="font-mono">{j.kind}</span> · {j.status} · attempt {j.attempts}/{j.maxAttempts} · {j.updated}
                    {j.lastError ? <div className="text-ink-2">{j.lastError}</div> : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Card>
      </div>

      <h2 className="mb-3 mt-6 text-lg font-semibold">Conexões: cota e sincronizações recentes</h2>
      {vm.connections.length === 0 ? <p className="text-sm text-ink-2">Nenhuma conexão.</p> : null}
      <div className="grid gap-4 xl:grid-cols-2">
        {vm.connections.map((c) => (
          <Card key={c.id} labelledBy={`sys-${c.id}`}>
            <CardTitle id={`sys-${c.id}`}>
              <span className="inline-flex flex-wrap items-center gap-2">
                {c.label} <Pill tone={c.status === "active" ? "healthy" : "critical"}>{c.status}</Pill> {c.isDemo ? <DemoBadge /> : null}
              </span>
            </CardTitle>
            <p className="mb-2 text-xs text-ink-2">
              Última sincronização: {c.lastSync} · {c.failures} consecutive failures
            </p>
            <h3 className="mb-1 text-sm font-semibold">Limites de uso da API do Buffer (compartilhados com suas automações de publicação)</h3>
            {c.windows.length === 0 ? (
              <p className="mb-3 text-xs text-ink-2">Nenhum limite de uso registrado ainda.</p>
            ) : (
              <ul className="mb-3 space-y-1.5">
                {c.windows.map((w) => (
                  <li key={w.name} className="text-xs">
                    <div className="flex justify-between gap-2">
                      <span className="font-mono">{w.name}</span>
                      <span className="tabular-nums">
                        {w.remaining}/{w.limit} remaining ({w.pct}%) · resets {w.resets}
                      </span>
                    </div>
                    <div className="mt-0.5 h-2 overflow-hidden rounded bg-canvas" role="img" aria-label={`${w.pct}% restante da cota ${w.name}`}>
                      <div className={`h-full ${w.pct < 20 ? "bg-critical" : w.pct < 50 ? "bg-warning" : "bg-accent"}`} style={{ width: `${w.pct}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <h3 className="mb-1 text-sm font-semibold">Sincronizações recentes</h3>
            {c.runs.length === 0 ? (
              <p className="text-xs text-ink-2">Nenhuma sincronização ainda.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table w-full text-xs">
                  <caption className="sr-only">Sincronizações recentes for {c.label}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Started</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Situação</th>
                      <th scope="col">Duration</th>
                      <th scope="col">Requests</th>
                      <th scope="col">Items</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.runs.map((r) => (
                      <tr key={r.id}>
                        <td className="whitespace-nowrap">{r.started}</td>
                        <td>{r.kind}</td>
                        <td>
                          <Pill tone={r.status === "succeeded" ? "healthy" : r.status === "failed" ? "critical" : "neutral"}>{r.status}</Pill>
                          {r.error ? <div className="mt-0.5 max-w-xs break-words text-ink-2">{r.error}</div> : null}
                        </td>
                        <td className="tabular-nums">{r.duration}</td>
                        <td className="tabular-nums">{r.requests}</td>
                        <td className="tabular-nums">{r.items}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
