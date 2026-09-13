import { Skeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite" className="grid gap-4 xl:grid-cols-2">
      <span className="sr-only">Loading brand dashboard…</span>
      {[0, 1].map((i) => (
        <div key={i} className="rounded-lg border border-line bg-surface p-4">
          <Skeleton className="mb-4 h-5 w-48" />
          {Array.from({ length: 5 }, (_, j) => (
            <Skeleton key={j} className="mb-3 h-12 w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}
