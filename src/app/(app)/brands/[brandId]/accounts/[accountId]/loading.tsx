import { Skeleton, TableSkeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading account…</span>
      <Skeleton className="mb-4 h-8 w-64" />
      <div className="mb-4 grid grid-cols-1 gap-2 rounded-lg border border-line bg-surface p-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
      <TableSkeleton rows={6} />
    </div>
  );
}
