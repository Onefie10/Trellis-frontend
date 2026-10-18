import { NextResponse } from 'next/server'
import { reloadSimulation } from '../../../../../lib/simulations'
import { csrfMiddleware } from '../../../../../lib/security/csrf'

export async function POST(req: Request, ctx: any) {
  const csrfError = csrfMiddleware(req)
  if (csrfError) return csrfError

  const id: string = ctx?.params?.id
  try {
    const sim = await reloadSimulation(id)
    return NextResponse.json(sim)
  } catch (err: any) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 })
  }
}
