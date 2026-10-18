import { NextRequest, NextResponse } from 'next/server'
import { runSimulation } from '../../../../../lib/simulations'
import { checkRateLimit, createRateLimitResponse } from '../../../../../lib/security/rate-limit'
import { csrfMiddleware } from '../../../../../lib/security/csrf'

const SIMULATION_RATE_LIMIT = { maxRequests: 20, windowMs: 60 * 1000, scope: 'simulations' };

export async function POST(req: NextRequest, ctx: any) {
  const csrfError = csrfMiddleware(req);
  if (csrfError) return csrfError;

  const rl = checkRateLimit(req, SIMULATION_RATE_LIMIT);
  if (rl.blocked) {
    return createRateLimitResponse(rl, 'Too many simulations running. Please try again later.');
  }

  const id: string = ctx?.params?.id
  try {
    const run = await runSimulation(id)
    return NextResponse.json(run)
  } catch (err: any) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 })
  }
}
