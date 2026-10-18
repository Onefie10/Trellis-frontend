import { NextRequest, NextResponse } from 'next/server';
import { PRIORITY_REWARDS, CATEGORY_MULTIPLIERS, type BugReport } from '../../../types/bug-report';
import { paginateBugReports } from '@/lib/bug-reports-pagination';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { checkRateLimit, createRateLimitResponse } from '@/lib/security/rate-limit';
import { csrfMiddleware } from '@/lib/security/csrf';

// In-memory storage for demo purposes
// In production, this would be replaced with a database
const bugReports: BugReport[] = [];

export function getBugReports(): readonly BugReport[] {
  return bugReports;
}

const BUG_REPORT_RATE_LIMIT = { maxRequests: 5, windowMs: 60 * 60 * 1000, scope: 'bug_reports' };

export async function POST(request: NextRequest) {
  const csrfError = csrfMiddleware(request);
  if (csrfError) return csrfError;

  const rl = checkRateLimit(request, BUG_REPORT_RATE_LIMIT);
  if (rl.blocked) {
    return createRateLimitResponse(rl, 'Too many bug reports submitted. Please try again later.');
  }

  try {
    const formData = await request.formData();
    
    // Extract form fields
    const title = formData.get('title') as string;
    const description = formData.get('description') as string;
    const stepsToReproduce = formData.get('stepsToReproduce') as string;
    const expectedBehavior = formData.get('expectedBehavior') as string;
    const actualBehavior = formData.get('actualBehavior') as string;
    const priority = formData.get('priority') as 'low' | 'medium' | 'high' | 'critical';
    const category = formData.get('category') as 'ui' | 'functionality' | 'performance' | 'security' | 'other';
    const reporterEmail = formData.get('reporterEmail') as string;
    const agreeToTerms = formData.get('agreeToTerms') === 'true';
    
    // Extract screenshots
    const screenshots: string[] = [];
    for (let i = 0; i < 5; i++) {
      const screenshot = formData.get(`screenshot_${i}`) as File;
      if (screenshot) {
        // In production, upload to cloud storage and store URL
        // For demo, we'll just store the filename
        screenshots.push(screenshot.name);
      }
    }

    // Validate required fields
    if (!title || !description || !stepsToReproduce || !expectedBehavior || !actualBehavior || !priority || !category || !agreeToTerms) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Calculate reward
    const baseReward = PRIORITY_REWARDS[priority];
    const categoryMultiplier = CATEGORY_MULTIPLIERS[category];
    const rewardAmount = Math.round(baseReward * categoryMultiplier);

    // Create bug report
    const bugReport: BugReport = {
      id: `BR-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      title,
      description,
      stepsToReproduce,
      expectedBehavior,
      actualBehavior,
      priority,
      category,
      screenshots,
      reporterAddress: 'demo-wallet-address', // In production, get from authenticated user
      reporterEmail: reporterEmail || undefined,
      status: 'submitted',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rewardAmount,
      rewardStatus: 'pending'
    };

    // Store bug report
    bugReports.push(bugReport);

    console.log('Bug report submitted:', bugReport);

    return NextResponse.json({
      success: true,
      bugReport: {
        id: bugReport.id,
        title: bugReport.title,
        status: bugReport.status,
        rewardAmount: bugReport.rewardAmount,
        estimatedPayoutDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      }
    });

  } catch (error) {
    console.error('Error submitting bug report:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') as BugReport['status'] | 'all' | null;
    const limit = Number(searchParams.get('limit') || 10);

    if (isFeatureEnabled('stableBugReportPagination')) {
      const page = paginateBugReports(bugReports, {
        cursor: searchParams.get('cursor'),
        limit,
        status: status || 'all',
      });

      return NextResponse.json({
        bugReports: page.records,
        total: bugReports.length,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    }

    const filteredReports = status && status !== 'all'
      ? bugReports.filter((report) => report.status === status)
      : bugReports;

    return NextResponse.json({
      bugReports: filteredReports.slice(0, 10),
      total: bugReports.length
    });
  } catch (error) {
    console.error('Error fetching bug reports:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
