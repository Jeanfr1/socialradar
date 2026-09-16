import { Skeleton, TableSkeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Carregando desempenho de conteúdo…</span>
      <Skeleton className="mb-4 h-24 w-full" />
      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-40 w-full" />
        ))}
      </div>
      <TableSkeleton rows={10} />
    </div>
  );
}
