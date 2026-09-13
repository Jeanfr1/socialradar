import { TableSkeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return <TableSkeleton rows={8} label="Loading settings…" />;
}
