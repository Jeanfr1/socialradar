"use client";

import { useActionState } from "react";
import { IDLE_RESULT, type FormAction } from "@/components/forms/action-result";

export function LoginForm({ action }: { action: FormAction }) {
  const [state, formAction, pending] = useActionState(action, IDLE_RESULT);
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <div>
        <label htmlFor="email" className="label">
          Email
        </label>
        <input id="email" name="email" type="email" autoComplete="username" required className="input" />
      </div>
      <div>
        <label htmlFor="password" className="label">
          Password
        </label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className="input" />
      </div>
      <div aria-live="polite" role="status">
        {state.status === "error" ? (
          <div className="rounded-md border border-critical/40 bg-[#fdf1f0] px-3 py-2 text-sm">
            <p className="text-critical">{state.message}</p>
            <p className="mt-1 text-ink-2">Still stuck? Contact your admin.</p>
          </div>
        ) : null}
      </div>
      <button type="submit" disabled={pending} className="btn btn-primary w-full">
        {pending ? "Signing in…" : "Sign in"}
      </button>
      <p className="text-center text-xs text-ink-2">
        Forgot password? BrandPulse is invite-only — ask a workspace administrator to reset it.
      </p>
    </form>
  );
}
