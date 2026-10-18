import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const title = searchParams.get('title') || 'Join Trellis Marketplace';
    const reward = searchParams.get('reward') || 'Earn Rewards';
    const code = searchParams.get('code') || '';
    const agentName = searchParams.get('agentName') || '';
    const price = searchParams.get('price') || '';

    return new ImageResponse(
      (
        <div
          style={{
            height: '100%',
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#0f0f23',
            color: 'white',
            fontFamily: 'sans-serif',
            backgroundImage: 'radial-gradient(circle at top right, rgba(79, 191, 155, 0.25), transparent 70%)',
            padding: '40px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 64, fontWeight: 900, color: '#4fbf9b', marginBottom: 20 }}>
            {title}
          </div>
          
          {agentName && (
            <div style={{ fontSize: 42, marginBottom: 10 }}>
              Agent: {agentName}
            </div>
          )}
          
          {price && (
            <div style={{ fontSize: 32, color: '#aaa', marginBottom: 30 }}>
              Price: {price}
            </div>
          )}
          
          <div style={{ fontSize: 36, marginTop: 20 }}>
            {reward}
          </div>

          {code && (
            <div
              style={{
                marginTop: 40,
                fontSize: 48,
                padding: '10px 30px',
                border: '4px dashed #4fbf9b',
                borderRadius: 20,
                backgroundColor: 'rgba(79, 191, 155, 0.1)',
                fontWeight: 'bold',
              }}
            >
              Code: {code}
            </div>
          )}
        </div>
      ),
      {
        width: 1200,
        height: 630,
      }
    );
  } catch (e: any) {
    return new Response(`Failed to generate the image`, {
      status: 500,
    });
  }
}
