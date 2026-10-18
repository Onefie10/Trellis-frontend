import type { Metadata, Viewport } from 'next';
import './globals.css';
import ClientProviders from '@/components/providers/ClientProviders';
import Navigation from '@/components/Navigation';
import OfflineBanner from '@/components/OfflineBanner';
import PWAInstall from '@/components/PWAInstall';
import { Toaster } from 'sonner';

export const metadata: Metadata = {
  metadataBase: new URL('http://localhost:3000'),
  title: 'Trellis - AI Agent Marketplace',
  description: 'Create, discover, and interact with AI agents on the Stellar network',
  keywords: ['AI agents', 'marketplace', 'automation', 'AI', 'Stellar'],
  openGraph: {
    title: 'Trellis',
    description: 'An AI agent marketplace built on Stellar',
    type: 'website',
    images: [
      {
        url: '/icons/icon-512x512.png',
        width: 512,
        height: 512,
        alt: 'Trellis',
      },
    ],
  },
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Trellis',
    startupImage: [
      {
        url: '/icons/icon-192x192.png',
        media: '(device-width: 320px) and (device-height: 568px) and (-webkit-device-pixel-ratio: 2)',
      },
    ],
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: '/icons/icon-72x72.png', sizes: '72x72', type: 'image/png' },
      { url: '/icons/icon-96x96.png', sizes: '96x96', type: 'image/png' },
      { url: '/icons/icon-128x128.png', sizes: '128x128', type: 'image/png' },
      { url: '/icons/icon-144x144.png', sizes: '144x144', type: 'image/png' },
      { url: '/icons/icon-152x152.png', sizes: '152x152', type: 'image/png' },
      { url: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-384x384.png', sizes: '384x384', type: 'image/png' },
      { url: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/icons/icon-152x152.png', sizes: '152x152', type: 'image/png' },
    ],
  },
  other: {
    'msapplication-TileColor': '#0E1A16',
    'msapplication-config': '/browserconfig.xml',
  },
};

export const viewport: Viewport = {
  themeColor: '#0E1A16',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Critical resource hints for performance */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        
        {/* DNS prefetch for external resources */}
        <link rel="dns-prefetch" href="//fonts.googleapis.com" />
        <link rel="dns-prefetch" href="//fonts.gstatic.com" />
        

        
        {/* PWA meta tags */}
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Trellis" />
        
        {/* Critical CSS inline */}
        <style
          dangerouslySetInnerHTML={{
            __html: `
              /* Critical CSS for above-the-fold content */
              body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
              .min-h-screen { min-height: 100vh; }
              .bg-gradient-to-br { background-image: linear-gradient(to bottom right, var(--tw-gradient-stops)); }
              .from-trellis-ground { --tw-gradient-from: #0E1A16; --tw-gradient-stops: var(--tw-gradient-from), var(--tw-gradient-to, rgb(14 26 22 / 0)); }
              .via-trellis-deep { --tw-gradient-stops: var(--tw-gradient-from), #070F0D, var(--tw-gradient-to, rgb(7 15 13 / 0)); }
              .to-trellis-ground { --tw-gradient-to: #0E1A16; }
              .text-white { --tw-text-opacity: 1; color: rgb(255 255 255 / var(--tw-text-opacity)); }
              .overflow-x-hidden { overflow-x: hidden; }
              .fixed { position: fixed; }
              .inset-0 { inset: 0px; }
              .pointer-events-none { pointer-events: none; }
              .absolute { position: absolute; }
              .w-1 { width: 0.25rem; }
              .h-1 { height: 0.25rem; }
              .bg-white { --tw-bg-opacity: 1; background-color: rgb(255 255 255 / var(--tw-bg-opacity)); }
              .rounded-full { border-radius: 9999px; }
              .relative { position: relative; }
              .z-10 { z-index: 10; }
              @keyframes twinkle { 0%, 100% { opacity: 0; } 50% { opacity: 1; } }
              .animate-twinkle { animation: twinkle 3s ease-in-out infinite; }
            `,
          }}
        />
      </head>
      <body className="bg-trellis-ground text-white overflow-x-hidden" suppressHydrationWarning>
        <ClientProviders>
          <div className="relative z-10">
            <Navigation />
            {children}
          </div>

          <OfflineBanner />

          <Toaster richColors position="bottom-right" />
        </ClientProviders>
      </body>
    </html>
  );
}

export default RootLayout;