import { NextRequest, NextResponse } from 'next/server';
import {
  getReferralClickMetrics,
  recordReferralClickEvent,
} from '@/lib/affiliate-store';
import { VanitySlugError } from '@/lib/vanity-slug';
import { csrfMiddleware } from '@/lib/security/csrf';

/**
 * GET /api/affiliates/referral-clicks?wallet=<address>&days=30
 *   CTR / conversion metrics for the wallet's vanity slugs.
 *
 * POST /api/affiliates/referral-clicks
 *   { slug, referrer?, userAgent?, conversionStatus?, kind? }
 *   Record one click (or view) against a registered vanity slug. The store
 *   derives device type and referrer source from the request context.
 */

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const wallet = params.get('wallet');

    if (!wallet) {
      return NextResponse.json(
        { error: 'Wallet address required' },
        { status: 400 },
      );
    }

    const daysParam = Number(params.get('days') ?? '30');
    const days =
      Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 365) : 30;

    return NextResponse.json(getReferralClickMetrics(wallet, days));
  } catch (error) {
    console.error('Error fetching referral click metrics:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const csrfError = csrfMiddleware(request);
  if (csrfError) return csrfError;

  try {
    const body = await request.json();
    const { slug, referrer, userAgent, conversionStatus, kind } = body ?? {};

    if (!slug) {
      return NextResponse.json(
        { error: 'slug is required' },
        { status: 400 },
      );
    }

    const event = recordReferralClickEvent({
      slug,
      referrer,
      userAgent,
      conversionStatus,
      kind,
    });

    return NextResponse.json(event, { status: 201 });
  } catch (error) {
    if (error instanceof VanitySlugError) {
      return NextResponse.json(
        { error: error.message, reason: error.reason },
        { status: error.httpStatus },
      );
    }
    console.error('Error recording referral click:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
