import {
  aggregateOperationalUptimeStats,
  aggregateTopFailingRoutes,
  buildExecutiveOperationalReport,
  deriveExceptionRoute,
  escapeCsvCell,
  formatOperationalMetricsCsv,
  normalizeOperationalRoute,
  OPERATIONAL_CSV_HEADERS,
  type BuildExecutiveOperationalReportInput,
  type ErrorTrendBucket,
  type ExecutiveOperationalReport,
  type FailingRouteStat,
  type OperationalErrorTrendSummary,
  type OperationalMetricSample,
  type OperationalUptimeStats,
  type ServiceUptimeSummary,
} from "../../lib/operational-health";

export {
  aggregateOperationalUptimeStats,
  aggregateTopFailingRoutes,
  buildExecutiveOperationalReport,
  deriveExceptionRoute,
  escapeCsvCell,
  formatOperationalMetricsCsv,
  normalizeOperationalRoute,
  OPERATIONAL_CSV_HEADERS,
  type BuildExecutiveOperationalReportInput,
  type ExecutiveOperationalReport,
  type FailingRouteStat,
  type OperationalErrorTrendSummary,
  type OperationalUptimeStats,
  type ServiceUptimeSummary,
};

const PAGE_WIDTH = 612; // US Letter width in pt
const PAGE_HEIGHT = 792; // US Letter height in pt
const MARGIN_LEFT = 44;
const MARGIN_RIGHT = 44;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;
const TOP_START_Y = PAGE_HEIGHT - 52;
const BOTTOM_LIMIT_Y = 56;

function escapePdfText(text: string): string {
  // Replace non-ASCII characters with safe ASCII equivalents for Type1 WinAnsi fonts
  const ascii = text
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2022/g, "*")
    .replace(/[^\x20-\x7E]/g, "?");
  return ascii
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 3))}...`;
}

class PdfDocumentBuilder {
  private pages: string[][] = [[]];
  private cursorY = TOP_START_Y;

  private get currentCommands(): string[] {
    return this.pages[this.pages.length - 1];
  }

  ensureSpace(heightNeeded: number): void {
    if (this.cursorY - heightNeeded < BOTTOM_LIMIT_Y) {
      this.newPage();
    }
  }

  newPage(): void {
    this.pages.push([]);
    this.cursorY = TOP_START_Y;
  }

  moveDown(pts: number): void {
    this.cursorY -= pts;
  }

  drawRect(
    x: number,
    y: number,
    width: number,
    height: number,
    fillRgb: [number, number, number],
  ): void {
    const [r, g, b] = fillRgb.map((c) => Number(c.toFixed(3)));
    this.currentCommands.push(
      `q ${r} ${g} ${b} rg ${x.toFixed(1)} ${y.toFixed(1)} ${width.toFixed(1)} ${height.toFixed(1)} re f Q`,
    );
  }

  drawLine(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    strokeRgb: [number, number, number] = [0.82, 0.85, 0.9],
    lineWidth = 0.75,
  ): void {
    const [r, g, b] = strokeRgb.map((c) => Number(c.toFixed(3)));
    this.currentCommands.push(
      `q ${r} ${g} ${b} RG ${lineWidth} w ${x1.toFixed(1)} ${y1.toFixed(1)} m ${x2.toFixed(1)} ${y2.toFixed(1)} l S Q`,
    );
  }

  drawText(
    text: string,
    x: number,
    y: number,
    options: {
      font?: "F1" | "F2" | "F3";
      size?: number;
      color?: [number, number, number];
    } = {},
  ): void {
    const font = options.font ?? "F1";
    const size = options.size ?? 10;
    const [r, g, b] = (options.color ?? [0.1, 0.14, 0.2]).map((c) =>
      Number(c.toFixed(3)),
    );
    this.currentCommands.push(
      `BT /${font} ${size} Tf ${r} ${g} ${b} rg ${x.toFixed(1)} ${y.toFixed(1)} Td (${escapePdfText(text)}) Tj ET`,
    );
  }

  drawSectionHeader(title: string): void {
    this.ensureSpace(36);
    this.moveDown(10);
    this.drawRect(
      MARGIN_LEFT,
      this.cursorY - 18,
      CONTENT_WIDTH,
      22,
      [0.93, 0.96, 0.95],
    );
    this.drawText(title, MARGIN_LEFT + 8, this.cursorY - 11, {
      font: "F2",
      size: 11,
      color: [0.06, 0.28, 0.22],
    });
    this.moveDown(26);
  }

  drawKeyValueRow(label: string, value: string): void {
    this.ensureSpace(16);
    this.drawText(label, MARGIN_LEFT + 6, this.cursorY - 10, {
      font: "F2",
      size: 9.5,
      color: [0.22, 0.27, 0.34],
    });
    this.drawText(value, MARGIN_LEFT + 190, this.cursorY - 10, {
      font: "F1",
      size: 9.5,
      color: [0.08, 0.12, 0.18],
    });
    this.moveDown(15);
  }

  drawTable(
    headers: readonly { label: string; xOffset: number; maxChars?: number }[],
    rows: readonly string[][],
  ): void {
    this.ensureSpace(28);
    const headerY = this.cursorY - 12;
    this.drawRect(
      MARGIN_LEFT,
      headerY - 4,
      CONTENT_WIDTH,
      18,
      [0.12, 0.18, 0.26],
    );
    for (const col of headers) {
      this.drawText(col.label, MARGIN_LEFT + col.xOffset, headerY, {
        font: "F2",
        size: 8.5,
        color: [0.96, 0.98, 1],
      });
    }
    this.moveDown(20);

    rows.forEach((row, rowIndex) => {
      this.ensureSpace(16);
      const rowY = this.cursorY - 10;
      if (rowIndex % 2 === 1) {
        this.drawRect(
          MARGIN_LEFT,
          rowY - 4,
          CONTENT_WIDTH,
          15,
          [0.97, 0.98, 0.99],
        );
      }
      row.forEach((cell, colIndex) => {
        const col = headers[colIndex];
        if (!col) return;
        const formatted = col.maxChars
          ? truncateText(cell, col.maxChars)
          : cell;
        this.drawText(formatted, MARGIN_LEFT + col.xOffset, rowY, {
          font: colIndex === 0 ? "F3" : "F1",
          size: 8.5,
          color: [0.12, 0.16, 0.22],
        });
      });
      this.moveDown(15);
    });

    this.drawLine(
      MARGIN_LEFT,
      this.cursorY,
      PAGE_WIDTH - MARGIN_RIGHT,
      this.cursorY,
    );
    this.moveDown(6);
  }

  build(reportGeneratedAt: string): Uint8Array {
    const totalPages = this.pages.length;

    // Add page footers to each page
    this.pages.forEach((commands, idx) => {
      const footerY = 28;
      commands.push(
        `q 0.82 0.85 0.9 RG 0.5 w ${MARGIN_LEFT} ${footerY + 12} m ${PAGE_WIDTH - MARGIN_RIGHT} ${footerY + 12} l S Q`,
      );
      commands.push(
        `BT /F1 8 Tf 0.4 0.45 0.52 rg ${MARGIN_LEFT} ${footerY} Td (${escapePdfText(
          `Trellis Maintainer Operations Report | Generated ${reportGeneratedAt} | Redacted Governance Summary`,
        )}) Tj ET`,
      );
      commands.push(
        `BT /F2 8 Tf 0.4 0.45 0.52 rg ${PAGE_WIDTH - MARGIN_RIGHT - 55} ${footerY} Td (${escapePdfText(
          `Page ${idx + 1} of ${totalPages}`,
        )}) Tj ET`,
      );
    });

    // Assemble PDF 1.4 objects
    // Obj 1: Catalog
    // Obj 2: Pages
    // Obj 3: Font F1 (Helvetica)
    // Obj 4: Font F2 (Helvetica-Bold)
    // Obj 5: Font F3 (Courier)
    // Obj 6: Info dictionary
    // Obj 7..: Page + Content stream pairs
    const objects: string[] = [];
    const pageObjectIds: number[] = [];

    objects.push("<< /Type /Catalog /Pages 2 0 R >>");
    objects.push(""); // Placeholder for Obj 2 (Pages)
    objects.push(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    );
    objects.push(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    );
    objects.push(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
    );
    objects.push(
      `<< /Title (Trellis Executive Operational Health Report) /Creator (Trellis Operations Dashboard) /CreationDate (D:${reportGeneratedAt.replace(/[-:T.Z]/g, "").slice(0, 14)}Z) >>`,
    );

    for (const pageCommands of this.pages) {
      const pageObjId = objects.length + 1;
      const contentObjId = objects.length + 2;
      pageObjectIds.push(pageObjId);

      const streamBody = pageCommands.join("\n");
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentObjId} 0 R >>`,
      );
      objects.push(
        `<< /Length ${streamBody.length} >>\nstream\n${streamBody}\nendstream`,
      );
    }

    objects[1] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjectIds.length} >>`;

    const chunks: string[] = ["%PDF-1.4\n"];
    const offsets: number[] = [0];
    let byteOffset = chunks[0].length;

    objects.forEach((objBody, idx) => {
      offsets.push(byteOffset);
      const serialized = `${idx + 1} 0 obj\n${objBody}\nendobj\n`;
      chunks.push(serialized);
      byteOffset += serialized.length;
    });

    const xrefOffset = byteOffset;
    const xrefLines = [
      "xref",
      `0 ${objects.length + 1}`,
      "0000000000 65535 f ",
      ...offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    ];
    const trailer = [
      ...xrefLines,
      "trailer",
      `<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>`,
      "startxref",
      String(xrefOffset),
      "%%EOF\n",
    ].join("\n");

    chunks.push(trailer);
    const fullText = chunks.join("");
    const encoder = new TextEncoder();
    return encoder.encode(fullText);
  }
}

/**
 * Generates a printable client-side PDF 1.4 document from an ExecutiveOperationalReport.
 */
export function generateOperationalReportPdf(
  report: ExecutiveOperationalReport,
): Uint8Array {
  const pdf = new PdfDocumentBuilder();

  // Executive Banner
  pdf.drawRect(MARGIN_LEFT, PAGE_HEIGHT - 102, CONTENT_WIDTH, 56, [0.05, 0.14, 0.22]);
  pdf.drawText(
    "TRELLIS OPERATIONAL HEALTH - EXECUTIVE REPORT",
    MARGIN_LEFT + 14,
    PAGE_HEIGHT - 68,
    { font: "F2", size: 14, color: [0.31, 0.75, 0.61] },
  );
  pdf.drawText(
    `Generated: ${report.generatedAt}   |   Evaluation Window: ${report.windowMinutes} min   |   SLA Status: ${
      report.uptime.slaMet ? "PASSING" : "ATTENTION REQUIRED"
    }`,
    MARGIN_LEFT + 14,
    PAGE_HEIGHT - 88,
    { font: "F1", size: 9, color: [0.88, 0.92, 0.96] },
  );
  pdf.moveDown(62);

  // 1. Uptime & System Reliability Statistics
  pdf.drawSectionHeader("1. Uptime & Service Reliability Statistics");
  pdf.drawKeyValueRow(
    "Overall Service Uptime:",
    `${report.uptime.overallUptimePercentage.toFixed(1)}% (SLA Target: ${report.uptime.slaTargetPercentage.toFixed(1)}% - ${
      report.uptime.slaMet ? "SLA Met" : "SLA Breached"
    })`,
  );
  pdf.drawKeyValueRow(
    "Monitored Services:",
    `${report.uptime.totalServicesCount} total (${report.uptime.healthyServicesCount} healthy, ${report.uptime.degradedServicesCount} degraded, ${report.uptime.downServicesCount} down)`,
  );
  pdf.drawKeyValueRow(
    "RPC Probe Latency (Avg / P95):",
    report.uptime.avgRpcLatencyMs !== null
      ? `${report.uptime.avgRpcLatencyMs} ms avg / ${report.uptime.p95RpcLatencyMs ?? report.uptime.avgRpcLatencyMs} ms p95`
      : "No RPC latency samples recorded",
  );
  pdf.drawKeyValueRow(
    "Peak Gateway Heap Utilization:",
    `${(report.uptime.peakHeapUsageRatio * 100).toFixed(1)}%`,
  );

  if (report.uptime.services.length > 0) {
    pdf.moveDown(4);
    pdf.drawTable(
      [
        { label: "Service", xOffset: 6, maxChars: 24 },
        { label: "Status", xOffset: 170, maxChars: 12 },
        { label: "Uptime %", xOffset: 255, maxChars: 10 },
        { label: "P50 (ms)", xOffset: 335, maxChars: 10 },
        { label: "P95 (ms)", xOffset: 405, maxChars: 10 },
        { label: "Consec. Failures", xOffset: 460, maxChars: 10 },
      ],
      report.uptime.services.map((svc) => [
        svc.label || svc.service,
        svc.status.toUpperCase(),
        `${svc.uptimePercentage.toFixed(1)}%`,
        String(svc.p50LatencyMs),
        String(svc.p95LatencyMs),
        String(svc.consecutiveFailures),
      ]),
    );
  }

  // 2. Operational Health Categories
  pdf.drawSectionHeader("2. Operational Health Categories");
  if (report.healthCategories.length > 0) {
    pdf.drawTable(
      [
        { label: "Category", xOffset: 6, maxChars: 34 },
        { label: "Count", xOffset: 250, maxChars: 12 },
        { label: "Severity", xOffset: 340, maxChars: 14 },
        { label: "Action Path", xOffset: 420, maxChars: 24 },
      ],
      report.healthCategories.map((cat) => [
        cat.label,
        String(cat.count),
        cat.severity.toUpperCase(),
        cat.href,
      ]),
    );
  }

  // 3. Error Trends & Alert Breaches
  pdf.drawSectionHeader("3. Error Trends & Alert Rule Evaluation");
  pdf.drawKeyValueRow(
    "Total Window Exceptions:",
    `${report.errorTrends.totalExceptions} (${report.errorTrends.criticalExceptions} critical, ${report.errorTrends.rpcExceptions} RPC errors)`,
  );
  pdf.drawKeyValueRow(
    "Error Rate (Avg / Peak):",
    `${report.errorTrends.avgErrorsPerMinute.toFixed(2)} errors/min avg   |   ${report.errorTrends.peakErrorsPerMinute.toFixed(2)} errors/min peak`,
  );
  pdf.drawKeyValueRow(
    "Error Trend Direction:",
    report.errorTrends.trendDirection.toUpperCase(),
  );
  pdf.drawKeyValueRow(
    "Active Alert Breaches:",
    report.errorTrends.activeBreaches.length === 0
      ? "None (all rules within threshold)"
      : report.errorTrends.activeBreaches
          .map(
            (b) =>
              `${b.ruleName} (${b.observed} > ${b.threshold}, ${b.severity})`,
          )
          .join("; "),
  );

  if (report.errorTrends.buckets.length > 0) {
    pdf.moveDown(4);
    pdf.drawTable(
      [
        { label: "Bucket (UTC)", xOffset: 6, maxChars: 16 },
        { label: "Total", xOffset: 130, maxChars: 10 },
        { label: "Rate / min", xOffset: 205, maxChars: 12 },
        { label: "Critical", xOffset: 300, maxChars: 10 },
        { label: "Error", xOffset: 380, maxChars: 10 },
        { label: "Warning", xOffset: 450, maxChars: 10 },
      ],
      report.errorTrends.buckets.slice(-12).map((bucket) => [
        bucket.label,
        String(bucket.count),
        bucket.ratePerMinute.toFixed(2),
        String(bucket.bySeverity.critical),
        String(bucket.bySeverity.error),
        String(bucket.bySeverity.warning),
      ]),
    );
  }

  // 4. Top Failing Routes
  pdf.drawSectionHeader("4. Top Failing Routes");
  if (report.topFailingRoutes.length === 0) {
    pdf.drawKeyValueRow(
      "Failing Routes:",
      "No route failures recorded in the selected evaluation window.",
    );
  } else {
    pdf.drawTable(
      [
        { label: "Route Template", xOffset: 6, maxChars: 30 },
        { label: "Failures", xOffset: 205, maxChars: 10 },
        { label: "Critical", xOffset: 270, maxChars: 10 },
        { label: "Share %", xOffset: 335, maxChars: 10 },
        { label: "Dominant Kind", xOffset: 400, maxChars: 12 },
        { label: "Last Seen", xOffset: 475, maxChars: 10 },
      ],
      report.topFailingRoutes.map((route) => [
        route.route,
        String(route.failureCount),
        String(route.criticalCount),
        `${route.errorRatePct.toFixed(1)}%`,
        route.dominantKind.toUpperCase(),
        route.lastSeenAt.slice(11, 19) || route.lastSeenAt,
      ]),
    );
  }

  return pdf.build(report.generatedAt);
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Generates and downloads the printable PDF operational health report in the browser.
 */
export function downloadOperationalReportPdf(
  report: ExecutiveOperationalReport,
  filename?: string,
): Uint8Array {
  const pdfBytes = generateOperationalReportPdf(report);
  const dateSuffix = report.generatedAt.slice(0, 10);
  const resolvedFilename =
    filename ?? `operational-health-report-${dateSuffix}.pdf`;
  const copy = new Uint8Array(pdfBytes.byteLength);
  copy.set(pdfBytes);
  const blob = new Blob([copy.buffer], { type: "application/pdf" });
  triggerBrowserDownload(blob, resolvedFilename);
  return pdfBytes;
}

/**
 * Formats and downloads raw operational time-series metric data as a CSV file in the browser.
 */
export function downloadOperationalMetricsCsv(
  samples: readonly OperationalMetricSample[],
  buckets: readonly ErrorTrendBucket[] = [],
  filename?: string,
): string {
  const csv = formatOperationalMetricsCsv(samples, buckets);
  const dateSuffix = new Date().toISOString().slice(0, 10);
  const resolvedFilename =
    filename ?? `operational-metrics-${dateSuffix}.csv`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  triggerBrowserDownload(blob, resolvedFilename);
  return csv;
}
