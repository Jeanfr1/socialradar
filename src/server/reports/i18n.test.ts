import { describe, expect, it } from "vitest";
import { messages } from "./i18n";

/** Collects every string the catalog can produce (functions are called with neutral placeholder arguments). */
function collectTexts(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "function") {
    try {
      collectTexts((value as (...a: unknown[]) => unknown)("X", "Y", 2, "2", 3, "3", "Z"), out);
    } catch {
      // Some templates expect structured arguments; the weekly/monthly wording check does not need them.
    }
  } else if (Array.isArray(value)) value.forEach((v) => collectTexts(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectTexts(v, out));
  return out;
}

describe("report wording per period kind", () => {
  it("pt-BR monthly catalog never mentions weeks and keeps agreement right", () => {
    const texts = collectTexts(messages("pt-BR", "month"));
    expect(texts.length).toBeGreaterThan(100);
    expect(texts.filter((t) => /semana/i.test(t))).toEqual([]);
    // Masculine "mês" must not keep feminine articles from "semana".
    expect(texts.filter((t) => /\b(na|da|a|uma|esta|nesta|próxima) mês\b/i.test(t))).toEqual([]);
    expect(messages("pt-BR", "month").labels.reportTitle).toBe("Relatório mensal");
  });

  it("es-ES and en-US monthly catalogs never mention weeks", () => {
    expect(collectTexts(messages("es-ES", "month")).filter((t) => /semana/i.test(t))).toEqual([]);
    expect(collectTexts(messages("en-US", "month")).filter((t) => /week/i.test(t))).toEqual([]);
  });

  it("weekly catalog is unchanged", () => {
    expect(messages("pt-BR").labels.reportTitle).toBe("Relatório semanal");
    expect(messages("pt-BR", "week")).toBe(messages("pt-BR"));
  });
});
