import { renderReportCsv } from "@/server/reports/service";
import { exportReport } from "../../export";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ reportId: string }> }): Promise<Response> {
  const { reportId } = await context.params;
  return exportReport(reportId, renderReportCsv, "text/csv; charset=utf-8");
}
