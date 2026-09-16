import { Skeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Carregando calendário…</span>
      <Skeleton className="mb-4 h-8 w-72" />
      <div className="grid grid-cols-7 gap-1 rounded-lg border border-line bg-surface p-2">
        {Array.from({ length: 35 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    </div>
  );
}
