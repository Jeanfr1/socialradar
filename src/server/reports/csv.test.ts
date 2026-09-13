import { describe, expect, it } from "vitest";
import { CSV_COLUMNS, csvCell, reportCsvRows, reportToCsv, toCsv } from "./csv";
import type { KpiRow, WeeklyReportContent } from "./types";

describe("csvCell", () => {
  it("quotes separators, quotes and line breaks (RFC 4180)", () => {
    expect(csvCell('a "quoted", value')).toBe('"a ""quoted"", value"');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell("plain")).toBe("plain");
  });

  it("neutralizes formula injection in text cells", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+1+1")).toBe("'+1+1");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tcmd")).toBe("'\tcmd");
    expect(csvCell("\rcmd")).toBe("\"'\rcmd\"");
  });

  it("keeps numbers numeric (including negatives) and missing values empty", () => {
    expect(csvCell(-12.5)).toBe("-12.5");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(Number.NaN)).toBe("");
  });

  it("prefixes a UTF-8 BOM and uses CRLF", () => {
    const out = toCsv([["a", "b"], [1, "ç"]]);
    expect(out.startsWith("﻿")).toBe(true);
    expect(out).toBe("﻿a,b\r\n1,ç\r\n");
  });
});

function kpiRow(overrides: Partial<KpiRow>): KpiRow {
  const cell = { value: null, status: "unsupported" as const, na: { code: "unsupported_by_provider" as const, message: "Não suportado" }, unit: "count" as const, postsIncluded: 0, postsTotal: 2, containsZeroUncertainty: false };
  return {
    metricId: "shares",
    definitionId: "sum:shares:v1",
    label: "Compartilhamentos (soma)",
    aggregation: "sum_distinct_posts",
    unit: "count",
    source: "buffer:post_metrics",
    latest: { ...cell, observedAtMin: null, observedAtMax: null },
    comparison: { basis: "age_matched", ageHours: 72, current: cell, previous: cell, absoluteChange: null, percentChange: null, na: cell.na, percentNa: null },
    status: "unsupported",
    ...overrides,
  };
}

describe("reportToCsv", () => {
  it("exports missing metrics as empty values with a status and neutralizes hostile handles", () => {
    const content = {
      period: { start: "2026-09-07", end: "2026-09-13", previousStart: "2026-08-31", previousEnd: "2026-09-06" },
      kpiTable: {
        accounts: [
          {
            accountId: "a",
            handle: "=cmd|' /C calc'!A0",
            displayName: null,
            platform: "youtube",
            rows: [
              kpiRow({}),
              kpiRow({
                metricId: "views",
                definitionId: "sum:views:v1",
                status: "available",
                latest: { value: 900, status: "available", na: null, unit: "count", postsIncluded: 2, postsTotal: 2, containsZeroUncertainty: false, observedAtMin: null, observedAtMax: "2026-09-15T10:00:00.000Z" },
                comparison: {
                  basis: "age_matched",
                  ageHours: 72,
                  current: { value: 600, status: "available", na: null, unit: "count", postsIncluded: 2, postsTotal: 2, containsZeroUncertainty: false },
                  previous: { value: 750, status: "available", na: null, unit: "count", postsIncluded: 3, postsTotal: 3, containsZeroUncertainty: false },
                  absoluteChange: -150,
                  percentChange: -20,
                  na: null,
                  percentNa: null,
                },
              }),
            ],
          },
        ],
      },
      publicationConsistency: { accounts: [] },
      bestContent: { items: [] },
      underperformingContent: { items: [] },
      audienceAndEngagementTrends: {
        audience: { accounts: [{ accountId: "a", handle: "yt", displayName: null, platform: "youtube", followers: { value: null, status: "unsupported", na: { code: "requires_direct_connection", message: "x" }, unit: "people", postsIncluded: 0, postsTotal: 0, containsZeroUncertainty: false } }] },
        engagement: [],
      },
    } as unknown as WeeklyReportContent;

    const csv = reportToCsv(content);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(csv).not.toContain(",=cmd");
    expect(csv).toContain("'=cmd|' /C calc'!A0");

    const rows = reportCsvRows(content);
    const shares = rows.find((r) => r.metric === "shares" && r.basis === "lifetime_to_date")!;
    expect(shares.value).toBeNull();
    expect(shares.status).toBe("unsupported");
    expect(shares.na_reason).toBe("unsupported_by_provider");
    const viewsCurrent = rows.find((r) => r.metric === "views" && r.basis === "age_matched_72h" && r.period === "2026-09-07/2026-09-13")!;
    expect(viewsCurrent).toMatchObject({ value: 600, change: -150, change_pct: -20 });
    expect(csv).toContain(",-150,-20,");
    const followers = rows.find((r) => r.metric === "followers")!;
    expect(followers).toMatchObject({ status: "unsupported", na_reason: "requires_direct_connection" });
    expect(followers.value).toBeUndefined();
  });
});
