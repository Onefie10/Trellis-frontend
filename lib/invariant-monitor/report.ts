/**
 * Report rendering for the invariant monitor.
 *
 * Two renderings of the same report: a human one for a terminal, and JSON for
 * CI. Both are derived from the same `MonitorReport` object, so they cannot
 * disagree about what failed.
 *
 * Colour is opt-out via `NO_COLOR` and suppressed automatically when the
 * stream is not a TTY, so redirected CI logs stay readable.
 */

import type { InvariantResult, MonitorReport, Severity } from './types';

const ESC = String.fromCharCode(27);

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'CRITICAL',
  error: 'ERROR',
  warning: 'WARNING',
};

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: `${ESC}[31m`,
  error: `${ESC}[31m`,
  warning: `${ESC}[33m`,
};

const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const GREEN = `${ESC}[32m`;
const CYAN = `${ESC}[36m`;
const MAGENTA = `${ESC}[35m`;

export interface RenderOptions {
  color?: boolean;
}

function palette(enabled: boolean) {
  const wrap = (code: string) => (text: string) => (enabled ? `${code}${text}${RESET}` : text);
  return {
    bold: wrap(BOLD),
    dim: wrap(DIM),
    green: wrap(GREEN),
    cyan: wrap(CYAN),
    magenta: wrap(MAGENTA),
    severity: (severity: Severity) =>
      enabled ? `${SEVERITY_COLOR[severity]}${SEVERITY_LABEL[severity]}${RESET}` : SEVERITY_LABEL[severity],
  };
}

function rule(width = 72): string {
  return '='.repeat(width);
}

function summarizeLine(report: MonitorReport): string {
  const { summary } = report;
  const { critical, error, warning } = summary.violationsBySeverity;
  return (
    `${summary.passed}/${summary.totalInvariants} invariants passed · ` +
    `${critical} critical, ${error} error, ${warning} warning`
  );
}

function renderResult(result: InvariantResult, colors: ReturnType<typeof palette>): string[] {
  const lines: string[] = [];
  const status = result.status === 'pass' ? colors.green('PASS') : colors.bold(SEVERITY_LABEL[result.severity]);
  const coverage =
    result.evaluatedRecords === 0 ? colors.dim('no records in scope') : `${result.evaluatedRecords} record(s)`;

  lines.push(`  ${status}  ${colors.bold(result.id)}  ${result.title}`);
  lines.push(`        ${colors.dim(`${result.domain} · ${coverage}`)}`);

  for (const entry of result.violations) {
    lines.push(`        ${colors.severity(entry.severity)}  ${entry.message}`);
    for (const record of entry.records) {
      const field = record.field ? `.${record.field}` : '';
      lines.push(`          ${colors.magenta(`${record.entityType}#${record.entityId}${field}`)} — ${record.detail}`);
    }
    lines.push(`          ${colors.dim(`Next step: ${entry.remediation}`)}`);
  }

  return lines;
}

export function renderTextReport(report: MonitorReport, options: RenderOptions = {}): string {
  const useColor = options.color ?? false;
  const colors = palette(useColor);
  const lines: string[] = [];

  lines.push(colors.cyan(rule()));
  lines.push(colors.cyan('   Trellis — Invariant Monitor'));
  lines.push(colors.cyan(rule()));
  lines.push(`Source:     ${report.source}`);
  lines.push(`Generated:  ${report.timestamp}`);
  lines.push(`Fail on:    ${SEVERITY_LABEL[report.failOn]} or worse`);
  lines.push('');

  lines.push(colors.bold('Records scanned:'));
  for (const [collection, count] of Object.entries(report.summary.entitiesScanned)) {
    lines.push(`  - ${collection}: ${count}`);
  }
  lines.push('');

  for (const domain of ['funds', 'ownership', 'lifecycle', 'authorization'] as const) {
    const results = report.results.filter((result) => result.domain === domain);
    if (results.length === 0) continue;
    const failed = results.filter((result) => result.status === 'fail').length;
    lines.push(colors.bold(`${domain.toUpperCase()} (${results.length - failed}/${results.length} passing)`));
    for (const result of results) lines.push(...renderResult(result, colors));
    lines.push('');
  }

  lines.push(colors.cyan(rule()));
  lines.push(colors.bold(`Summary: ${summarizeLine(report)}`));

  if (report.ok) {
    lines.push(colors.green('No invariant failed at or above the failure threshold.'));
  } else {
    lines.push(
      colors.bold(
        `Monitoring FAILED: ${report.summary.failed} invariant(s) reported findings at ${SEVERITY_LABEL[report.failOn]} or worse.`
      )
    );
    lines.push('Review the findings above, then re-run the monitor. Do not edit the snapshot to clear them.');
  }

  return lines.join('\n');
}

/** JSON payload, suitable for CI annotation or archiving as a build artifact. */
export function renderJsonReport(report: MonitorReport): string {
  return JSON.stringify(report, null, 2);
}
