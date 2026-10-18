import type { BugReport } from '@/types/bug-report';
import {
  buildGitHubIssuePayload,
  buildGithubIssueMarkdown,
  mapGithubIssueStateToBugReportStatus,
} from '@/lib/bug-report-sync';

const report: BugReport = {
  id: 'BR-123',
  title: 'Login form crashes on submit',
  description: 'Submitting the login form throws a client exception during validation.',
  stepsToReproduce: '1. Open the login page\n2. Enter a valid email\n3. Submit the form',
  expectedBehavior: 'The form should submit successfully and route the user to the dashboard.',
  actualBehavior: 'The app throws a TypeError and the submit button remains disabled.',
  priority: 'critical',
  category: 'functionality',
  screenshots: ['screenshot-1.png'],
  reporterAddress: 'GDEV...',
  reporterEmail: 'tester@example.com',
  status: 'submitted',
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
  rewardAmount: 100,
  rewardStatus: 'pending',
};

describe('bug-report sync helpers', () => {
  it('builds a formatted GitHub issue markdown body with browser and console details', () => {
    const markdown = buildGithubIssueMarkdown({
      ...report,
      browserDetails: 'Chrome 129.0.0 on macOS 14.6\nViewport 1440x900',
      consoleLogs: 'TypeError: Cannot read properties of undefined (reading "value")',
    });

    expect(markdown).toContain('## Summary');
    expect(markdown).toContain('## Steps to reproduce');
    expect(markdown).toContain('1. Open the login page');
    expect(markdown).toContain('Chrome 129.0.0 on macOS 14.6');
    expect(markdown).toContain('TypeError: Cannot read properties of undefined (reading "value")');
  });

  it('creates a GitHub issue payload with labels for bug triage and severity', () => {
    const payload = buildGitHubIssuePayload({
      ...report,
      labels: ['needs-triage'],
      browserDetails: 'Firefox 130',
      consoleLogs: 'ReferenceError in login handler',
    });

    expect(payload.title).toBe('Login form crashes on submit');
    expect(payload.labels).toEqual(expect.arrayContaining(['bug', 'triage', 'needs-triage', 'critical', 'functionality']));
    expect(payload.body).toContain('## Browser details');
    expect(payload.body).toContain('Firefox 130');
  });

  it('maps GitHub issue states back to in-app bug status values', () => {
    expect(mapGithubIssueStateToBugReportStatus('closed')).toBe('resolved');
    expect(mapGithubIssueStateToBugReportStatus('reopened')).toBe('in_progress');
    expect(mapGithubIssueStateToBugReportStatus('open')).toBe('under_review');
  });
});
