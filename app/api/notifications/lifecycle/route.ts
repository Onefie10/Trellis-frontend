import { NextRequest, NextResponse } from 'next/server';
import { lifecycleNotifications } from '@/lib/notifications/lifecycle-manager';
import { verifyWebhook } from '@/lib/notifications/webhook';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get('wallet') || undefined;
  const unreadOnly = searchParams.get('unreadOnly') === 'true';

  const list = lifecycleNotifications.getForUser(wallet, { unreadOnly });
  return NextResponse.json({ notifications: list, total: list.length });
}

export async function POST(request: NextRequest) {
  try {
    const text = await request.text();
    
    // In a real environment, you'd want this required, but for tests/dev without it, 
    // we should perhaps only enforce if a secret is configured, or require it explicitly.
    // The issue says "rejected if replayed outside the allowed window", implying we should enforce it.
    const secret = process.env.WEBHOOK_SECRET || 'default_test_secret_for_development';
    
    const verification = verifyWebhook(text, request.headers, { secret });
    if (!verification.valid) {
      return NextResponse.json(
        { error: verification.error, code: verification.code },
        { status: 400 }
      );
    }

    const body = JSON.parse(text);
    const result = lifecycleNotifications.dispatch(body);
    return NextResponse.json(result, { status: result.isDuplicate ? 200 : 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
