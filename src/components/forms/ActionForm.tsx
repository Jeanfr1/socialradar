"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { IDLE_RESULT, type FormAction } from "./action-result";

export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  className = "",
  name,
  value,
  disabled,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "danger";
  className?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name={name} value={value} disabled={pending || disabled} className={`btn btn-${variant} ${className}`}>
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}

export function ActionMessage({ status, message }: { status: string; message?: string }) {
  return (
    <p aria-live="polite" role="status" className={`min-h-[1.25rem] text-sm ${status === "error" ? "text-critical" : "text-healthy"}`}>
      {status !== "idle" && message ? message : ""}
    </p>
  );
}

/**
 * Generic form bound to a server action through useActionState. Hidden fields are passed as `hidden`.
 * The result message is announced in an aria-live region.
 */
export function ActionForm({
  action,
  hidden,
  children,
  submitLabel,
  pendingLabel,
  variant = "primary",
  className = "",
  inline = false,
}: {
  action: FormAction;
  hidden?: Record<string, string>;
  children?: React.ReactNode;
  submitLabel?: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "danger";
  className?: string;
  inline?: boolean;
}) {
  const [state, formAction] = useActionState(action, IDLE_RESULT);
  return (
    <form action={formAction} className={className}>
      {hidden ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
      <div className={inline ? "flex flex-wrap items-end gap-2" : "space-y-3"}>
        {children}
        {submitLabel ? (
          <div>
            <SubmitButton variant={variant} pendingLabel={pendingLabel}>
              {submitLabel}
            </SubmitButton>
          </div>
        ) : null}
      </div>
      <ActionMessage status={state.status} message={state.message} />
    </form>
  );
}
