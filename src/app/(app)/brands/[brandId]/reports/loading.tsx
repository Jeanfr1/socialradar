import { Skeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading reports…</span>
      <Skeleton className="mb-4 h-8 w-56" />
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="mb-3 rounded-lg border border-line bg-surface p-4">
          <Skeleton className="mb-2 h-5 w-64" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
      ))}
    </div>
  );
}
