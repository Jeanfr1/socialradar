import { Skeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading alerts…</span>
      <Skeleton className="mb-4 h-8 w-40" />
      <Skeleton className="mb-4 h-10 w-full" />
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="mb-3 rounded-lg border border-line bg-surface p-4">
          <Skeleton className="mb-2 h-5 w-32" />
          <Skeleton className="mb-2 h-5 w-2/3" />
          <Skeleton className="h-4 w-full" />
        </div>
      ))}
    </div>
  );
}
