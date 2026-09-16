"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface TrendPoint {
  day: string;
  label: string;
  /** Null = no usable data that day: rendered as a gap, never as zero. */
  value: number | null;
  n: number;
}

function formatValue(v: number, unit: "count" | "percent"): string {
  return unit === "percent" ? `${v.toFixed(2)}%` : new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(v);
}

/** Single-metric line chart (no dual axes). Missing days break the line. Includes a text summary and data table. */
export function TrendChart({
  id,
  title,
  yLabel,
  unit,
  points,
  summary,
}: {
  id: string;
  title: string;
  yLabel: string;
  unit: "count" | "percent";
  points: TrendPoint[];
  summary: string;
}) {
  const withData = points.filter((p) => p.value !== null);
  return (
    <figure aria-labelledby={`${id}-title`} aria-describedby={`${id}-summary`} className="min-w-0 rounded-md border border-line bg-surface p-3">
      <figcaption id={`${id}-title`} className="text-sm font-semibold">
        {title}
      </figcaption>
      <p id={`${id}-summary`} className="mb-2 text-xs text-ink-2">
        {summary}
      </p>
      {withData.length === 0 ? (
        <p className="flex h-40 items-center justify-center rounded border border-dashed border-line-strong text-sm text-ink-2">Sem dados utilizáveis neste intervalo.</p>
      ) : (
        <div className="h-48 w-full" aria-hidden="true">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: 12 }}>
              <CartesianGrid stroke="#E2E5EA" strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#5B6472" }} minTickGap={18} />
              <YAxis
                tick={{ fontSize: 11, fill: "#5B6472" }}
                width={64}
                tickFormatter={(v: number) => formatValue(v, unit)}
                label={{ value: yLabel, angle: -90, position: "insideLeft", offset: 0, style: { fontSize: 11, fill: "#5B6472", textAnchor: "middle" } }}
              />
              <Tooltip
                formatter={(v) => (typeof v === "number" ? formatValue(v, unit) : "Sem dados")}
                labelStyle={{ color: "#111827" }}
              />
              <Line type="linear" dataKey="value" name={yLabel} stroke="#2451B0" strokeWidth={2} dot={{ r: 3, fill: "#2451B0" }} connectNulls={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      <details className="mt-2 text-xs">
        <summary className="link cursor-pointer">Tabela de dados</summary>
        <div className="mt-1 max-h-56 overflow-auto">
          <table className="data-table w-full">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col">Dia</th>
                <th scope="col">{yLabel}</th>
                <th scope="col">Posts</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.day}>
                  <th scope="row" className="font-normal">
                    {p.label}
                  </th>
                  <td className="tabular-nums">{p.value === null ? "Sem dados" : formatValue(p.value, unit)}</td>
                  <td className="tabular-nums">{p.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
