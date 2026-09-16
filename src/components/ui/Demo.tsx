import { Icon } from "./Icon";

/** Persistent, non-dismissible banner for any page showing demo fixtures. */
export function DemoBanner({ scope }: { scope?: string }) {
  return (
    <div role="note" className="mb-4 flex items-start gap-2 rounded-lg border-2 border-demo bg-demo px-4 py-3 text-white">
      <Icon name="flask" className="mt-0.5 h-5 w-5" />
      <p>
        <strong className="font-semibold">Dados de demonstração — não são métricas reais.</strong>{" "}
        {scope ?? "Tudo nesta página marcado como Demo vem de dados fictícios. Nenhuma conta real está conectada nesta visão."}
      </p>
    </div>
  );
}

export function DemoBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-demo/50 bg-demo-soft px-2 py-0.5 text-xs font-semibold text-demo">
      <Icon name="flask" className="h-3 w-3" />
      Demo
    </span>
  );
}
