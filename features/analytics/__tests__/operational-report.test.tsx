import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  buildExecutiveOperationalReport,
  downloadOperationalMetricsCsv,
  downloadOperationalReportPdf,
  formatOperationalMetricsCsv,
  generateOperationalReportPdf,
} from "../operational-report";
import { buildOperationalHealth, type ExceptionEvent, type ExternalServiceHealth, type OperationalMetricSample } from "@/lib/operational-health";
import OperationsDashboardPage from "@/app/dashboard/operations/page";

jest.mock("recharts", () => {
  const OriginalRecharts = jest.requireActual("recharts");
  return {
    ...OriginalRecharts,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 800, height: 400 }}>{children}</div>
    ),
  };
});

describe("Operational Report PDF Generator and CSV Exporter", () => {
  const NOW = Date.parse("2026-03-15T12:00:00.000Z");

  const sampleEvents: ExceptionEvent[] = [
    {
      id: "ex-1",
      ts: NOW - 120_000,
      kind: "rpc",
      severity: "critical",
      component: "wallet",
      browserOS: "macOS",
      release: "v1.4.0",
      route: "/api/rpc/simulate",
    },
    {
      id: "ex-2",
      ts: NOW - 60_000,
      kind: "api",
      severity: "error",
      component: "governance",
      browserOS: "Windows",
      release: "v1.4.0",
      route: "/api/governance/proposals/42",
    },
  ];

  const sampleServices: ExternalServiceHealth[] = [
    {
      service: "horizon",
      label: "Stellar Horizon API",
      endpoint: "https://horizon-testnet.stellar.org",
      status: "healthy",
      lastCheckedAt: new Date(NOW).toISOString(),
      lastLatencyMs: 95,
      rollingLatency: { p50: 95, p95: 140, p99: 180, min: 80, max: 180, avg: 105, samplesCount: 10 },
      uptimePercentage: 99.9,
      consecutiveFailures: 0,
      lastError: null,
    },
  ];

  const sampleMetrics: OperationalMetricSample[] = [
    {
      ts: NOW - 60_000,
      heapUsedBytes: 40 * 1024 * 1024,
      heapTotalBytes: 100 * 1024 * 1024,
      activeConnections: 4,
      rpcLatencyMs: 95,
    },
  ];

  test("generates a valid printable PDF 1.4 document with executive summary, uptime stats, error trends, and top failing routes", () => {
    const report = buildExecutiveOperationalReport({
      now: NOW,
      windowMinutes: 60,
      health: buildOperationalHealth([], NOW),
      exceptionEvents: sampleEvents,
      metricSamples: sampleMetrics,
      externalServices: sampleServices,
    });

    const pdfBytes = generateOperationalReportPdf(report);
    const pdfText = new TextDecoder().decode(pdfBytes);

    expect(pdfText.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdfText).toContain("TRELLIS OPERATIONAL HEALTH - EXECUTIVE REPORT");
    expect(pdfText).toContain("1. Uptime & Service Reliability Statistics");
    expect(pdfText).toContain("99.9%");
    expect(pdfText).toContain("Stellar Horizon API");
    expect(pdfText).toContain("2. Operational Health Categories");
    expect(pdfText).toContain("3. Error Trends & Alert Rule Evaluation");
    expect(pdfText).toContain("4. Top Failing Routes");
    expect(pdfText).toContain("/api/rpc/simulate");
    expect(pdfText).toContain("/api/governance/proposals/:param");
    expect(pdfText).toContain("xref");
    expect(pdfText.trim().endsWith("%%EOF")).toBe(true);
  });

  test("triggers browser downloads for PDF report and CSV metrics", () => {
    if (!URL.createObjectURL) {
      (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:mock";
    }
    if (!URL.revokeObjectURL) {
      (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    }

    const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const createUrlSpy = jest.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-report");
    const revokeUrlSpy = jest.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const report = buildExecutiveOperationalReport({
      now: NOW,
      windowMinutes: 60,
      exceptionEvents: sampleEvents,
      metricSamples: sampleMetrics,
      externalServices: sampleServices,
    });

    const pdfBytes = downloadOperationalReportPdf(report);
    expect(pdfBytes.byteLength).toBeGreaterThan(500);
    expect(createUrlSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeUrlSpy).toHaveBeenCalledWith("blob:mock-report");

    const csv = downloadOperationalMetricsCsv(sampleMetrics, report.errorTrends.buckets);
    expect(csv).toBe(formatOperationalMetricsCsv(sampleMetrics, report.errorTrends.buckets));
    expect(createUrlSpy).toHaveBeenCalledTimes(2);
    expect(clickSpy).toHaveBeenCalledTimes(2);

    clickSpy.mockRestore();
    createUrlSpy.mockRestore();
    revokeUrlSpy.mockRestore();
  });

  test("renders Export PDF Report and Export CSV buttons on OperationsDashboardPage and downloads files", async () => {
    if (!URL.createObjectURL) {
      (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:mock";
    }
    if (!URL.revokeObjectURL) {
      (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    }

    const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const createUrlSpy = jest.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-dashboard");
    const revokeUrlSpy = jest.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...buildOperationalHealth([], NOW),
        exceptions: sampleEvents,
        externalServices: sampleServices,
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    render(<OperationsDashboardPage />);

    const pdfBtn = await screen.findByTestId("export-pdf-report-btn");
    const csvBtn = await screen.findByTestId("export-metrics-csv-btn");

    expect(pdfBtn).toBeInTheDocument();
    expect(csvBtn).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId("executive-report-summary")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(pdfBtn);
    expect(await screen.findByText(/Executive PDF operational report generated and downloaded/i)).toBeInTheDocument();

    await user.click(csvBtn);
    expect(await screen.findByText(/Raw time-series operational metrics exported as CSV/i)).toBeInTheDocument();

    expect(clickSpy).toHaveBeenCalledTimes(2);

    clickSpy.mockRestore();
    createUrlSpy.mockRestore();
    revokeUrlSpy.mockRestore();
  });
});
