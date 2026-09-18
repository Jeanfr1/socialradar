import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/forms/ActionForm";
import { Card, CardTitle, PageHeader } from "@/components/ui/Card";
import { DemoBanner } from "@/components/ui/Demo";
import { PermissionMessage } from "@/components/ui/States";
import { Pill } from "@/components/ui/StatusBadge";
import {
  addMemberAction,
  archiveBrandAction,
  changeRoleAction,
  removeMemberAction,
  updateBrandAction,
  updateCadenceAction,
} from "@/server/actions/settings";
import { ForbiddenError, NotFoundError, requireUser } from "@/server/auth/authz";
import { getDb } from "@/server/db/client";
import { loadBrandSettings, type BrandSettingsVM } from "@/server/queries/pages/settings";

export const metadata: Metadata = { title: "Configurações da marca" };

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ROLES = ["owner", "manager", "viewer"] as const;

function NumberField({ id, name, label, defaultValue, min, max, hint }: { id: string; name: string; label: string; defaultValue: number | string; min: number; max: number; hint?: string }) {
  return (
    <div>
      <label htmlFor={id} className="label text-xs">
        {label}
      </label>
      <input id={id} name={name} type="number" inputMode="numeric" min={min} max={max} defaultValue={defaultValue} className="input" />
      {hint ? <p className="mt-0.5 text-[11px] text-ink-2">{hint}</p> : null}
    </div>
  );
}

export default async function BrandSettingsPage({ params }: { params: Promise<{ brandId: string }> }) {
  const { brandId } = await params;
  const user = await requireUser("page");
  let vm: BrandSettingsVM;
  try {
    vm = await loadBrandSettings(getDb(), user, brandId, new Date());
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return <PermissionMessage title="As configurações não estão disponíveis para o seu papel">Gerentes e proprietários podem alterar as configurações desta marca. Você tem acesso só de leitura.</PermissionMessage>;
    }
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const b = vm.brand;

  return (
    <>
      {b.isDemo ? <DemoBanner scope="Esta é uma marca de demonstração. As alterações afetam só os dados fictícios." /> : null}
      <PageHeader
        title={`${b.name} settings`}
        subtitle={<>Your role: {vm.role}</>}
        actions={
          <Link href={`/brands/${b.id}`} className="btn btn-secondary">
            Abrir calendário
          </Link>
        }
      />
      <datalist id="tz-options">
        {vm.timezones.map((tz) => (
          <option key={tz} value={tz} />
        ))}
      </datalist>

      <Card labelledBy="profile" className="mb-4">
        <CardTitle id="profile">Perfil e relatórios</CardTitle>
        <ActionForm action={updateBrandAction} hidden={{ brandId: b.id }} submitLabel="Salvar configurações da marca" pendingLabel="Saving…">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <div>
              <label htmlFor="b-name" className="label">
                Nome
              </label>
              <input id="b-name" name="name" required maxLength={80} defaultValue={b.name} className="input" />
            </div>
            <div>
              <label htmlFor="b-logo" className="label">
                Logo URL
              </label>
              <input id="b-logo" name="logoUrl" type="url" maxLength={2048} defaultValue={b.logoUrl} placeholder="https://" className="input" />
            </div>
            <div>
              <label htmlFor="b-tz" className="label">
                Fuso horário
              </label>
              <input id="b-tz" name="timezone" list="tz-options" required defaultValue={b.timezone} className="input" />
            </div>
            <div>
              <label htmlFor="b-locale" className="label">
                Idioma dos relatórios
              </label>
              <select id="b-locale" name="reportLocale" defaultValue={b.reportLocale} className="input">
                {vm.locales.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
              <p className="mt-0.5 text-xs text-ink-2">Idioma usado nos textos dos relatórios semanais e mensais.</p>
            </div>
            <div>
              <label htmlFor="b-day" className="label">
                Dia do relatório semanal
              </label>
              <select id="b-day" name="reportDay" defaultValue={String(b.reportSchedule.dayOfWeek)} className="input">
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i + 1}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="b-time" className="label">
                Report time ({b.timezone})
              </label>
              <input id="b-time" name="reportTime" type="time" required defaultValue={b.reportSchedule.time} className="input" />
            </div>
            <label className="flex items-center gap-2 text-sm md:col-span-2 xl:col-span-3">
              <input type="checkbox" name="reportEnabled" defaultChecked={b.reportSchedule.enabled} className="h-4 w-4" />
              Gerar os relatórios semanal e mensal automaticamente
            </label>
            <div className="md:col-span-2 xl:col-span-3">
              <label htmlFor="b-goals" className="label">
                Business goals
              </label>
              <textarea id="b-goals" name="businessGoals" rows={3} maxLength={2000} defaultValue={b.businessGoals} className="input" />
            </div>
            <div className="md:col-span-2 xl:col-span-3">
              <label htmlFor="b-pillars" className="label">
                Content pillars <span className="font-normal text-ink-2">(um por linha, até 20)</span>
              </label>
              <textarea id="b-pillars" name="contentPillars" rows={4} defaultValue={b.contentPillars} className="input" />
            </div>
          </div>
        </ActionForm>
      </Card>

      {vm.isOwner ? (
        <Card labelledBy="members" className="mb-4">
          <CardTitle id="members">Membros e papéis</CardTitle>
          <p className="mb-3 text-xs text-ink-2">Proprietários gerenciam membros; gerentes cuidam da cadência e dos relatórios; leitores só visualizam. Toda marca mantém pelo menos um proprietário.</p>
          <div className="overflow-x-auto">
            <table className="data-table w-full text-sm">
              <caption className="sr-only">Membros da marca</caption>
              <thead>
                <tr>
                  <th scope="col">Membro</th>
                  <th scope="col">Último acesso</th>
                  <th scope="col">Papel</th>
                  <th scope="col">
                    <span className="sr-only">Remover</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(vm.members ?? []).map((m) => (
                  <tr key={m.userId}>
                    <th scope="row" className="font-medium">
                      {m.name} {m.isSelf ? <Pill>You</Pill> : null} {!m.isActive ? <Pill tone="warning">Inativo</Pill> : null}
                      <div className="text-xs font-normal text-ink-2">{m.email}</div>
                    </th>
                    <td className="text-xs">{m.lastLogin}</td>
                    <td>
                      <ActionForm action={changeRoleAction} hidden={{ brandId: b.id, userId: m.userId }} submitLabel="Atualizar" variant="secondary" inline>
                        <div>
                          <label htmlFor={`role-${m.userId}`} className="sr-only">
                            Role for {m.name}
                          </label>
                          <select id={`role-${m.userId}`} name="role" defaultValue={m.role} className="input">
                            {ROLES.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        </div>
                      </ActionForm>
                    </td>
                    <td>
                      <ActionForm action={removeMemberAction} hidden={{ brandId: b.id, userId: m.userId }} submitLabel="Remover" variant="danger" inline />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="mb-2 mt-4 text-sm font-semibold">Adicionar membro</h3>
          <ActionForm action={addMemberAction} hidden={{ brandId: b.id }} submitLabel="Adicionar membro" inline>
            <div>
              <label htmlFor="add-email" className="label text-xs">
                E-mail de um usuário existente
              </label>
              <input id="add-email" name="email" type="email" required className="input" />
            </div>
            <div>
              <label htmlFor="add-role" className="label text-xs">
                Papel
              </label>
              <select id="add-role" name="role" defaultValue="viewer" className="input">
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          </ActionForm>
          <p className="text-xs text-ink-2">Novas pessoas precisam ser criadas antes por um administrador em Configurações → Usuários.</p>
        </Card>
      ) : null}

      <section aria-labelledby="cadence" className="mb-4">
        <h2 id="cadence" className="mb-1 text-lg font-semibold">
          Cadência de publicação
        </h2>
        <p className="mb-3 text-sm text-ink-2">
          Usada nos relatórios para medir se os horários planejados foram cumpridos. O SocialRadar nunca altera nada no Buffer. Horários no formato HH:MM (24h), separados por vírgula.
        </p>
        {vm.cadences.length === 0 ? <p className="text-sm text-ink-2">Nenhum canal vinculado a esta marca ainda.</p> : null}
        <div className="grid gap-4 2xl:grid-cols-2">
          {vm.cadences.map((c) => (
            <Card key={c.accountId} labelledBy={`cadence-${c.accountId}-title`}>
              <div id={`cadence-${c.accountId}`} className="scroll-mt-4" />
              <CardTitle id={`cadence-${c.accountId}-title`}>
                @{c.handle.replace(/^@/, "")} <span className="text-sm font-normal text-ink-2">{c.platformLabel}</span> {c.isDefault ? <Pill>Default settings</Pill> : null}
              </CardTitle>
              <p className="mb-3 text-xs text-ink-2">
                Buffer schedule ({c.providerTimezone ?? "fuso do canal desconhecido"}): {c.providerSchedule}
              </p>
              <ActionForm action={updateCadenceAction} hidden={{ accountId: c.accountId }} submitLabel="Salvar cadência" pendingLabel="Saving…">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor={`mode-${c.accountId}`} className="label text-xs">
                      Origem da cadência
                    </label>
                    <select id={`mode-${c.accountId}`} name="mode" defaultValue={c.mode} className="input">
                      <option value="provider_schedule">Buffer posting schedule</option>
                      <option value="custom">Horários personalizados (abaixo)</option>
                      <option value="irregular">Irregular: posts per week</option>
                      <option value="paused">Pause monitoring</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor={`tz-${c.accountId}`} className="label text-xs">
                      Fuso da cadência (vazio = do canal ou da marca)
                    </label>
                    <input id={`tz-${c.accountId}`} name="timezone" list="tz-options" defaultValue={c.timezone} className="input" />
                  </div>
                </div>
                <fieldset className="rounded-md border border-line p-2">
                  <legend className="px-1 text-xs font-medium">Horários personalizados (usados quando a origem é Personalizada; dias pausados também valem para Irregular)</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {c.days.map((d) => (
                      <div key={d.day} className="flex items-end gap-2">
                        <div className="min-w-0 flex-1">
                          <label htmlFor={`t-${c.accountId}-${d.day}`} className="label text-xs">
                            {d.label} times
                          </label>
                          <input id={`t-${c.accountId}-${d.day}`} name={`times_${d.day}`} defaultValue={d.times} placeholder="09:00, 18:30" className="input" />
                        </div>
                        <label className="flex min-h-10 items-center gap-1 text-xs">
                          <input type="checkbox" name={`paused_${d.day}`} defaultChecked={d.paused} className="h-4 w-4" /> Pausado
                        </label>
                      </div>
                    ))}
                  </div>
                </fieldset>
                <div className="grid gap-3 sm:grid-cols-3">
                  <NumberField id={`ppw-${c.accountId}`} name="postsPerWeek" label="Posts per week (irregular)" defaultValue={c.postsPerWeek} min={1} max={100} />
                  <div>
                    <label htmlFor={`mm-${c.accountId}`} className="label text-xs">
                      Slot matching
                    </label>
                    <select id={`mm-${c.accountId}`} name="matchMode" defaultValue={c.matchMode} className="input">
                      <option value="same_day">Same local day</option>
                      <option value="time_window">Within tolerance</option>
                    </select>
                  </div>
                  <NumberField id={`tol-${c.accountId}`} name="matchToleranceMinutes" label="Tolerância (minutos)" defaultValue={c.matchToleranceMinutes} min={5} max={720} />
                  <NumberField id={`hz-${c.accountId}`} name="horizonDays" label="Horizonte (dias)" defaultValue={c.horizonDays} min={1} max={60} />
                  <NumberField id={`wd-${c.accountId}`} name="warningDays" label="Limite de atenção (dias)" defaultValue={c.warningDays} min={1} max={60} />
                  <NumberField id={`cd-${c.accountId}`} name="criticalDays" label="Limite crítico (dias)" defaultValue={c.criticalDays} min={1} max={60} />
                  <NumberField id={`st-${c.accountId}`} name="staleAfterMinutes" label="Desatualizado após (minutos)" defaultValue={c.staleAfterMinutes} min={15} max={10080} hint="Dados da fila mais antigos que isso são considerados desatualizados." />
                </div>
              </ActionForm>
            </Card>
          ))}
        </div>
      </section>

      {vm.isOwner ? (
        <Card labelledBy="archive">
          <CardTitle id="archive">{b.archived ? "Restaurar marca" : "Arquivar marca"}</CardTitle>
          <p className="mb-2 text-sm text-ink-2">Marcas arquivadas somem do app e dos relatórios automáticos. Os dados são mantidos.</p>
          <ActionForm action={archiveBrandAction} hidden={{ brandId: b.id, archived: b.archived ? "false" : "true" }} submitLabel={b.archived ? "Restaurar marca" : "Arquivar marca"} variant={b.archived ? "secondary" : "danger"} inline />
        </Card>
      ) : null}
    </>
  );
}
