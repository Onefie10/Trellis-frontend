import { NextRequest, NextResponse } from 'next/server';
import {
  getOrCreateReferralCode,
  isValidStellarAddress,
  listReferrals,
} from '@/lib/affiliate-store';
import { csrfMiddleware } from '@/lib/security/csrf';

/**
 * GET /api/affiliates/referrals?wallet=<address>
 * Fetch all referral records for an affiliate from the affiliate store.
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

    return NextResponse.json(listReferrals(wallet));
  } catch (error) {
    console.error('Error fetching referrals:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/affiliates/referrals
 * Get-or-create the wallet's referral code. Codes are persisted in the
 * affiliate store so they can be resolved for attribution later; repeated
 * calls return the same code instead of minting a new one each time.
 */
export async function POST(request: NextRequest) {
  const csrfError = csrfMiddleware(request);
  if (csrfError) return csrfError;

  try {
    const body = await request.json();
    const { walletAddress } = body;

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'Wallet address required' },
        { status: 400 }
      );
    }

    // Validate Stellar address format
    if (!isValidStellarAddress(walletAddress)) {
      return NextResponse.json(
        { error: 'Invalid Stellar address format' },
        { status: 400 }
      );
    }

    const { code, createdAt } = getOrCreateReferralCode(walletAddress);

    return NextResponse.json(
      { code, createdAt },
      { status: 201 }
    );
  } catch (error) {
    console.error('Error generating referral code:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
