"use client";

import { useActionState } from "react";
import { IDLE_RESULT, type FormAction } from "@/components/forms/action-result";

export function LoginForm({ action }: { action: FormAction }) {
  const [state, formAction, pending] = useActionState(action, IDLE_RESULT);
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <div>
        <label htmlFor="email" className="label">
          E-mail
        </label>
        <input id="email" name="email" type="email" autoComplete="username" required className="input" />
      </div>
      <div>
        <label htmlFor="password" className="label">
          Senha
        </label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className="input" />
      </div>
      <div aria-live="polite" role="status">
        {state.status === "error" ? (
          <div className="rounded-md border border-critical/40 bg-[#fdf1f0] px-3 py-2 text-sm">
            <p className="text-critical">{state.message}</p>
            <p className="mt-1 text-ink-2">Ainda com problema? Fale com o seu administrador.</p>
          </div>
        ) : null}
      </div>
      <button type="submit" disabled={pending} className="btn btn-primary w-full">
        {pending ? "Entrando…" : "Entrar"}
      </button>
      <p className="text-center text-xs text-ink-2">
        Esqueceu a senha? O BrandPulse é apenas por convite — peça a um administrador do workspace para redefini-la.
      </p>
    </form>
  );
}
