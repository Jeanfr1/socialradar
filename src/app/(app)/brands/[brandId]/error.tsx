"use client";

import { RouteError } from "@/components/ui/RouteError";

export default function BrandError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <RouteError error={error} retry={retry} message="We couldn't load this brand's data." />;
}
