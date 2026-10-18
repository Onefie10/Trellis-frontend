import { NextRequest, NextResponse } from 'next/server';
import {
  getVanitySlugUrl,
  listVanitySlugs,
  registerVanitySlug,
  resolveVanitySlug,
} from '@/lib/affiliate-store';
import { validateVanitySlug, VanitySlugError } from '@/lib/vanity-slug';
import { csrfMiddleware } from '@/lib/security/csrf';

/**
 * GET /api/affiliates/vanity-slugs
 *   ?wallet=<address>  -> vanity aliases owned by that wallet
 *   ?slug=<slug>       -> { slug, available, reason } availability probe
 *
 * POST /api/affiliates/vanity-slugs
 *   { walletAddress, slug, targetAgentId } -> register a vanity alias
 *
 * The alias registry lives in lib/affiliate-store so the same store that
 * validates slugs also resolves them when clicks are recorded.
 */

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const slug = params.get('slug');

    if (slug !== null) {
      const validation = validateVanitySlug(slug);
      if (!validation.valid) {
        return NextResponse.json({
          slug: validation.normalized,
          available: false,
          reason: validation.reason,
          error: validation.error,
        });
      }
      const existing = resolveVanitySlug(validation.normalized);
      return NextResponse.json({
        slug: validation.normalized,
        available: existing === null,
        reason: existing === null ? undefined : 'COLLISION',
      });
    }

    const wallet = params.get('wallet');
    if (!wallet) {
      return NextResponse.json(
        { error: 'Wallet address required' },
        { status: 400 },
      );
    }

    return NextResponse.json(listVanitySlugs(wallet));
  } catch (error) {
    console.error('Error reading vanity slugs:', error);
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
    const { walletAddress, slug, targetAgentId } = body ?? {};

    if (!walletAddress || !slug || !targetAgentId) {
      return NextResponse.json(
        { error: 'walletAddress, slug and targetAgentId are required' },
        { status: 400 },
      );
    }

    const record = registerVanitySlug(walletAddress, slug, targetAgentId);
    return NextResponse.json(
      { ...record, url: getVanitySlugUrl(record) },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof VanitySlugError) {
      return NextResponse.json(
        { error: error.message, reason: error.reason },
        { status: error.httpStatus },
      );
    }
    console.error('Error registering vanity slug:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
