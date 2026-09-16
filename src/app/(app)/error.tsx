"use client";

import { RouteError } from "@/components/ui/RouteError";

export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <RouteError error={error} retry={retry} message="Não foi possível carregar esta página." />;
}
