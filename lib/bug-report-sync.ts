import type { BugReport } from '@/types/bug-report';

export interface GitHubIssueMetadata {
  browserDetails?: string;
  consoleLogs?: string;
  labels?: string[];
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  reporterAddress?: string;
  reporterEmail?: string;
}

export function buildGithubIssueMarkdown(
  report: Partial<BugReport> & GitHubIssueMetadata = {},
): string {
  const title = report.title ?? 'Untitled bug report';
  const description = report.description ?? 'No description provided.';
  const stepsToReproduce = report.stepsToReproduce ?? 'No reproduction steps were provided.';
  const expectedBehavior = report.expectedBehavior ?? 'No expected behavior was provided.';
  const actualBehavior = report.actualBehavior ?? 'No actual behavior was provided.';
  const priority = report.priority ? `**Priority**: ${report.priority}` : '**Priority**: not provided';
  const category = report.category ? `**Category**: ${report.category}` : '**Category**: not provided';
  const browserDetails = report.browserDetails ?? 'Browser details were not supplied.';
  const consoleLogs = report.consoleLogs ?? 'No console logs captured.';
  const reporterEmail = report.reporterEmail ?? 'Not provided';
  const reporterAddress = report.reporterAddress ?? 'Unknown';
  const screenshots = report.screenshots && report.screenshots.length > 0
    ? report.screenshots.map((file, index) => `- Screenshot ${index + 1}: ${file}`).join('\n')
    : 'No screenshots attached.';

  return [
    '## Summary',
    `**Report ID**: ${report.id ?? 'unknown'}`,
    `**Title**: ${title}`,
    priority,
    category,
    '',
    '## Description',
    description,
    '',
    '## Steps to reproduce',
    stepsToReproduce,
    '',
    '## Expected behavior',
    expectedBehavior,
    '',
    '## Actual behavior',
    actualBehavior,
    '',
    '## Browser details',
    browserDetails,
    '',
    '## Console logs',
    '```text',
    consoleLogs,
    '```',
    '',
    '## Reporter',
    `**Email**: ${reporterEmail}`,
    `**Address**: ${reporterAddress}`,
    '',
    '## Screenshots',
    screenshots,
  ].join('\n');
}

export function buildGitHubIssuePayload(
  report: Partial<BugReport> & GitHubIssueMetadata = {},
): { title: string; body: string; labels: string[] } {
  const labels = Array.from(
    new Set([
      'bug',
      'triage',
      'frontend',
      ...(report.labels ?? []),
      ...(report.priority ? [report.priority] : []),
      ...(report.category ? [report.category] : []),
    ]),
  ).filter(Boolean);

  return {
    title: report.title ?? 'Bug report',
    body: buildGithubIssueMarkdown(report),
    labels,
  };
}

export function mapGithubIssueStateToBugReportStatus(
  state: string | null | undefined,
): BugReport['status'] {
  const normalized = (state ?? '').toLowerCase();

  switch (normalized) {
    case 'closed':
    case 'resolved':
      return 'resolved';
    case 'reopened':
      return 'in_progress';
    case 'open':
    default:
      return 'under_review';
  }
}
