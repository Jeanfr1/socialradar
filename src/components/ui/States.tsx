import Link from "next/link";
import { Icon } from "./Icon";
import { DEFINITIONS } from "./copy";

export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong bg-surface p-6 text-center">
      <p className="font-medium text-ink">{title}</p>
      {children ? <div className="mx-auto mt-1 max-w-prose text-ink-2">{children}</div> : null}
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  );
}

/** Data that exists conceptually but can't be retrieved or isn't supported — never rendered as empty or 0. */
export function UnavailableState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="hatch-unavailable rounded-lg border border-locked/30 p-4">
      <div className="rounded-md bg-surface/95 p-3">
        <p className="flex items-center gap-2 font-medium text-locked">
          <Icon name="circle-slash" />
          {title}
        </p>
        {children ? <div className="mt-1 text-ink-2">{children}</div> : null}
      </div>
    </div>
  );
}

export function Banner({
  tone,
  children,
  role,
}: {
  tone: "info" | "stale" | "error" | "warning" | "success";
  children: React.ReactNode;
  role?: "status" | "alert";
}) {
  const cls = {
    info: "border-accent/30 bg-accent-soft text-ink",
    stale: "border-stale/40 bg-[#fdf6e3] text-ink",
    warning: "border-warning/40 bg-[#fdf3e7] text-ink",
    error: "border-critical/40 bg-[#fdf1f0] text-ink",
    success: "border-healthy/40 bg-[#edf7f1] text-ink",
  }[tone];
  const icon = tone === "error" ? "alert-octagon" : tone === "stale" ? "clock-alert" : tone === "warning" ? "alert-triangle" : tone === "success" ? "check-circle" : "info";
  const iconCls = { info: "text-accent", stale: "text-stale", warning: "text-warning", error: "text-critical", success: "text-healthy" }[tone];
  return (
    <div role={role} className={`mb-4 flex items-start gap-2 rounded-lg border px-3 py-2.5 ${cls}`}>
      <Icon name={icon} className={`mt-0.5 h-4 w-4 ${iconCls}`} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Server-rendered partial-failure banner with a retry link back to the same URL. */
export function ErrorBanner({ message, retryHref }: { message: string; retryHref: string }) {
  return (
    <Banner tone="error" role="alert">
      {message}{" "}
      <Link href={retryHref} className="link font-medium" prefetch={false}>
        Tentar novamente
      </Link>
    </Banner>
  );
}

export function AudienceUnavailable() {
  return (
    <UnavailableState title="Requer conexão direta com a plataforma">
      <p>{DEFINITIONS.audienceUnavailable}</p>
      <details className="mt-2">
        <summary className="link cursor-pointer text-sm">Saiba mais</summary>
        <p className="mt-1 text-sm">
          A API do Buffer expõe apenas métricas em nível de post. Contagens de seguidores e de inscritos exigem conexões diretas com
          Instagram, TikTok ou YouTube, que ainda não estão disponíveis. O BrandPulse nunca mostra crescimento de audiência como 0 nem
          como estimativa.
        </p>
      </details>
    </UnavailableState>
  );
}

export function PermissionMessage({ title = "Você não tem acesso a esta página", children }: { title?: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-xl rounded-lg border border-line bg-surface p-6" role="status">
      <p className="flex items-center gap-2 text-base font-semibold text-ink">
        <Icon name="lock" className="h-5 w-5 text-locked" />
        {title}
      </p>
      <div className="mt-2 text-ink-2">
        {children ?? "Seu perfil não inclui esta área. Fale com um administrador do workspace se precisar de acesso."}
      </div>
      <p className="mt-4">
        <Link href="/portfolio" className="link">
          Voltar para o Portfólio
        </Link>
      </p>
    </div>
  );
}
