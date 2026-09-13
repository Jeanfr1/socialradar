"use client";

import { useActionState, useId, useState } from "react";
import { IDLE_RESULT, type FormAction } from "@/components/forms/action-result";
import { ActionMessage, SubmitButton } from "@/components/forms/ActionForm";

export function AlertActions({
  alertId,
  state,
  timezone,
  zone,
  action,
}: {
  alertId: string;
  state: "open" | "acknowledged" | "snoozed" | "resolved";
  timezone: string;
  zone: string;
  action: FormAction;
}) {
  const [result, formAction] = useActionState(action, IDLE_RESULT);
  const [duration, setDuration] = useState("1d");
  const id = useId();
  return (
    <form action={formAction} className="mt-3 border-t border-line pt-3">
      <input type="hidden" name="alertId" value={alertId} />
      <div className="flex flex-wrap items-end gap-2">
        {state === "open" || state === "snoozed" ? (
          <SubmitButton name="intent" value="acknowledge" variant="secondary">
            Acknowledge
          </SubmitButton>
        ) : null}
        {state !== "resolved" ? (
          <>
            <div>
              <label htmlFor={`${id}-duration`} className="sr-only">
                Snooze duration
              </label>
              <select id={`${id}-duration`} name="duration" value={duration} onChange={(e) => setDuration(e.target.value)} className="input min-w-28">
                <option value="1h">1 hour</option>
                <option value="1d">1 day</option>
                <option value="1w">1 week</option>
                <option value="custom">Custom…</option>
              </select>
            </div>
            {duration === "custom" ? (
              <div>
                <label htmlFor={`${id}-until`} className="label text-xs">
                  Snooze until ({timezone}, {zone})
                </label>
                <input id={`${id}-until`} name="customUntil" type="datetime-local" required className="input" />
              </div>
            ) : null}
            <SubmitButton name="intent" value="snooze" variant="secondary">
              Snooze
            </SubmitButton>
            <SubmitButton name="intent" value="resolve" variant="secondary">
              Resolve
            </SubmitButton>
          </>
        ) : null}
        {state !== "open" ? (
          <SubmitButton name="intent" value="reopen" variant="secondary">
            {state === "snoozed" ? "Unsnooze" : "Reopen"}
          </SubmitButton>
        ) : null}
      </div>
      <ActionMessage status={result.status} message={result.message} />
    </form>
  );
}
