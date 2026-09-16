import { useId } from "react";
import { Icon } from "./Icon";

/**
 * Accessible definition tooltip: a focusable trigger described by a role="tooltip" element that shows on hover and
 * keyboard focus. `label` is the accessible name of the trigger (e.g. "About Coverage").
 */
export function InfoTip({
  label,
  children,
  align = "left",
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  const id = useId();
  return (
    <span className={`group relative inline-flex align-middle ${className}`}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-ink-2 hover:text-accent focus-visible:text-accent"
      >
        <Icon name="info" className="h-3.5 w-3.5" />
      </button>
      <span
        role="tooltip"
        id={id}
        className={`pointer-events-none invisible absolute top-full z-40 mt-1 w-72 max-w-[80vw] rounded-md border border-line bg-ink px-3 py-2 text-left text-xs font-normal leading-snug text-white opacity-0 shadow-lg transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100 ${
          align === "right" ? "right-0" : "left-0"
        }`}
      >
        {children}
      </span>
    </span>
  );
}

/** A term with its canonical definition attached as a tooltip. */
export function Term({ term, definition, align }: { term: string; definition: string; align?: "left" | "right" }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span>{term}</span>
      <InfoTip label={`Sobre ${term}`} align={align}>
        {definition}
      </InfoTip>
    </span>
  );
}
