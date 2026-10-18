import { NextRequest, NextResponse } from 'next/server';

import { getBugReports } from '@/app/api/bug-reports/route';
import { buildGitHubIssuePayload, mapGithubIssueStateToBugReportStatus } from '@/lib/bug-report-sync';
import { csrfMiddleware } from '@/lib/security/csrf';
import type { BugReport } from '@/types/bug-report';

const DEFAULT_REPOSITORY = 'TRELLIS-STELLAR/Trellis-frontend';
const DEFAULT_GITHUB_API_URL = 'https://api.github.com';

function getGitHubToken(): string {
  return process.env.GITHUB_TOKEN ?? process.env.GITHUB_PAT ?? '';
}

function getGitHubRepository(): string {
  return process.env.GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY;
}

function getGitHubApiUrl(): string {
  return process.env.GITHUB_API_URL ?? DEFAULT_GITHUB_API_URL;
}

function normalizeBugReport(rawReport: Partial<BugReport> | null | undefined): BugReport | null {
  if (!rawReport) {
    return null;
  }

  return {
    id: rawReport.id ?? `BR-${Date.now()}`,
    title: rawReport.title ?? 'Untitled bug report',
    description: rawReport.description ?? '',
    stepsToReproduce: rawReport.stepsToReproduce ?? '',
    expectedBehavior: rawReport.expectedBehavior ?? '',
    actualBehavior: rawReport.actualBehavior ?? '',
    priority: rawReport.priority ?? 'medium',
    category: rawReport.category ?? 'other',
    screenshots: rawReport.screenshots ?? [],
    reporterAddress: rawReport.reporterAddress ?? 'anonymous',
    reporterEmail: rawReport.reporterEmail,
    status: rawReport.status ?? 'submitted',
    createdAt: rawReport.createdAt ?? new Date().toISOString(),
    updatedAt: rawReport.updatedAt ?? new Date().toISOString(),
    rewardAmount: rawReport.rewardAmount ?? 0,
    rewardStatus: rawReport.rewardStatus ?? 'pending',
    assignedTo: rawReport.assignedTo,
    resolutionNotes: rawReport.resolutionNotes,
    githubIssueNumber: rawReport.githubIssueNumber,
    githubIssueUrl: rawReport.githubIssueUrl,
  };
}

async function createGitHubIssue(
  report: BugReport,
  metadata: { browserDetails?: string; consoleLogs?: string; labels?: string[] } = {},
) {
  const token = getGitHubToken();

  if (!token) {
    return {
      skipped: true,
      reason: 'GitHub token not configured',
    };
  }

  const payload = buildGitHubIssuePayload({
    ...report,
    labels: ['bug', 'triage', ...(metadata.labels ?? []), report.category, report.priority],
    browserDetails: metadata.browserDetails ?? 'Browser details were not supplied.',
    consoleLogs: metadata.consoleLogs ?? 'No console logs captured.',
  });

  const response = await fetch(`${getGitHubApiUrl()}/repos/${getGitHubRepository()}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub issue sync failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { number?: number; html_url?: string };

  report.githubIssueNumber = data.number;
  report.githubIssueUrl = data.html_url;
  report.status = 'under_review';
  report.updatedAt = new Date().toISOString();

  return {
    success: true,
    issueNumber: data.number,
    issueUrl: data.html_url,
  };
}

async function handleGitHubWebhook(payload: Record<string, unknown>) {
  const action = typeof payload.action === 'string' ? payload.action : '';
  const issue = payload.issue as { number?: number; state?: string; title?: string; body?: string } | undefined;

  if (!issue?.number) {
    return NextResponse.json({ success: true, ignored: true });
  }

  const report = getBugReports().find((candidate) => {
    if (candidate.githubIssueNumber === issue.number) {
      return true;
    }

    return candidate.title === issue.title || candidate.id === String(issue.number);
  });

  if (!report) {
    return NextResponse.json({ success: true, ignored: true, issueNumber: issue.number });
  }

  report.status = mapGithubIssueStateToBugReportStatus(issue.state);
  report.updatedAt = new Date().toISOString();

  return NextResponse.json({
    success: true,
    reportId: report.id,
    issueNumber: issue.number,
    status: report.status,
    action,
  });
}

export async function POST(request: NextRequest) {
  try {
    const eventType = request.headers.get('x-github-event');

    if (eventType) {
      const payload = await request.json().catch(() => ({}));
      return handleGitHubWebhook(payload as Record<string, unknown>);
    }

    const csrfError = csrfMiddleware(request);
    if (csrfError) return csrfError;

    const body = await request.json().catch(() => ({}));
    const action = typeof body?.action === 'string' ? body.action : 'approve';
    const bugReportRequest = body?.bugReport ?? body?.report ?? null;
    const bugReportId = typeof body?.bugReportId === 'string' ? body.bugReportId : bugReportRequest?.id ?? null;
    const browserDetails = typeof body?.browserDetails === 'string' ? body.browserDetails : undefined;
    const consoleLogs = typeof body?.consoleLogs === 'string' ? body.consoleLogs : undefined;

    if (action === 'sync-status') {
      const issueState = typeof body?.state === 'string' ? body.state : 'open';
      const report = getBugReports().find((candidate) => candidate.id === bugReportId) ?? normalizeBugReport(bugReportRequest);

      if (!report) {
        return NextResponse.json({ error: 'Bug report not found' }, { status: 404 });
      }

      report.status = mapGithubIssueStateToBugReportStatus(issueState);
      report.updatedAt = new Date().toISOString();
      return NextResponse.json({ success: true, reportId: report.id, status: report.status });
    }

    const report = getBugReports().find((candidate) => candidate.id === bugReportId)
      ?? normalizeBugReport(bugReportRequest as Partial<BugReport> | null | undefined);

    if (!report) {
      return NextResponse.json({ error: 'Bug report not found' }, { status: 404 });
    }

    const result = await createGitHubIssue(report, { browserDetails, consoleLogs });

    if ('skipped' in result && result.skipped) {
      return NextResponse.json({ success: false, skipped: true, reason: result.reason }, { status: 503 });
    }

    return NextResponse.json({ success: true, issue: result, reportId: report.id });
  } catch (error) {
    console.error('GitHub bug report sync failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to sync bug report to GitHub' },
      { status: 500 },
    );
  }
}
