import { Skeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Carregando recomendações…</span>
      <Skeleton className="mb-4 h-8 w-72" />
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="mb-3 grid gap-3 rounded-lg border border-line bg-surface p-4 lg:grid-cols-2">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ))}
    </div>
  );
}
