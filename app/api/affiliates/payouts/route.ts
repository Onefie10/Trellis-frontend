import { NextRequest, NextResponse } from 'next/server';
import {
  getPendingEarnings,
  isValidStellarAddress,
  listPayouts,
  PayoutError,
  requestPayout,
} from '@/lib/affiliate-store';
import { checkRateLimit, createRateLimitResponse } from '@/lib/security/rate-limit';
import { securityAuditLedger, walletAuditStreamId } from '@/lib/security/audit-ledger';
import { csrfMiddleware } from '@/lib/security/csrf';

const PAYOUTS_RATE_LIMIT = { maxRequests: 5, windowMs: 60 * 60 * 1000, scope: 'payouts' };

/**
 * GET /api/affiliates/payouts?wallet=<address>
 * Fetch payout history for an affiliate from the affiliate store.
 */
export async function GET(request: NextRequest) {
  try {
    const wallet = request.nextUrl.searchParams.get('wallet');

    if (!wallet) {
      return NextResponse.json(
        { error: 'Wallet address required' },
        { status: 400 }
      );
    }

    // Validate Stellar address format
    if (!isValidStellarAddress(wallet)) {
      return NextResponse.json(
        { error: 'Invalid Stellar address format' },
        { status: 400 }
      );
    }

    return NextResponse.json(listPayouts(wallet));
  } catch (error) {
    console.error('Error fetching payouts:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/affiliates/payouts
 * Request a payout.
 *
 * Payout flow: the frontend REQUESTS, the backend initiates the Stellar
 * transfer (see lib/affiliate-store `submitPayoutToNetwork` seam). A
 * request only QUEUES settlement — it never reports success without the
 * backend submission path accepting it, and a retry (same Idempotency-Key,
 * or a duplicate in-flight request) can never pay twice.
 */
export async function POST(request: NextRequest) {
  const csrfError = csrfMiddleware(request);
  if (csrfError) return csrfError;

  try {
    const body = await request.json();
    const { walletAddress, amount, destinationAddress, idempotencyKey } = body;

    const headerKey = request.headers.get('Idempotency-Key');
    const finalIdempotencyKey = idempotencyKey ?? headerKey ?? undefined;

    const rl = checkRateLimit(request, PAYOUTS_RATE_LIMIT, finalIdempotencyKey);
    if (rl.blocked) {
      return createRateLimitResponse(rl, 'Too many payout requests. Please try again later.');
    }

    // Validation
    if (!walletAddress || !amount || !destinationAddress) {
      return NextResponse.json(
        { error: 'Missing required fields: walletAddress, amount, destinationAddress' },
        { status: 400 }
      );
    }

    // Validate Stellar addresses
    if (!isValidStellarAddress(walletAddress) || !isValidStellarAddress(destinationAddress)) {
      return NextResponse.json(
        { error: 'Invalid Stellar address format' },
        { status: 400 }
      );
    }


    try {
      const { payout, replayed } = requestPayout({
        walletAddress,
        amount,
        destinationAddress,
        idempotencyKey: finalIdempotencyKey,
      });

      if (!replayed) {
        securityAuditLedger.append({
          streamId: walletAuditStreamId(walletAddress),
          category: 'financial',
          eventType: 'affiliate.payout.queued',
          actorId: 'affiliate-payout-api',
          payload: {
            payoutId: payout.id,
            walletAddress: payout.walletAddress,
            amount: payout.amount,
            status: payout.status,
            requestedAt: payout.requestedAt,
          },
        });
      }

      return NextResponse.json(
        {
          ...payout,
          pendingEarnings: getPendingEarnings(walletAddress).toFixed(2),
          message: replayed
            ? 'Duplicate request: returning the original payout. No additional funds moved.'
            : 'Payout queued for backend settlement. Funds have not moved yet.',
        },
        { status: replayed ? 200 : 201 },
      );
    } catch (error) {
      if (error instanceof PayoutError) {
        securityAuditLedger.append({
          streamId: walletAuditStreamId(walletAddress),
          category: 'financial',
          eventType: 'affiliate.payout.rejected',
          actorId: 'affiliate-payout-api',
          payload: {
            walletAddress,
            requestedAmount: String(amount),
            reasonCode: error.code,
          },
        });
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: error.httpStatus }
        );
      }
      throw error;
    }
  } catch (error) {
    console.error('Error requesting payout:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
