"use client";

import { useEffect } from "react";

/** Shared body for error.tsx boundaries. Server error details are never shown (only the digest). */
export function RouteError({
  error,
  retry,
  message,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  message: string;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="rounded-lg border border-critical/40 bg-[#fdf1f0] p-4">
      <p className="font-medium text-ink">{message}</p>
      {error.digest ? <p className="mt-1 text-xs text-ink-2">Referência: {error.digest}</p> : null}
      <button type="button" onClick={() => retry()} className="btn btn-secondary mt-3">
        Tentar novamente
      </button>
    </div>
  );
}
