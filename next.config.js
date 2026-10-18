/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https: wss:; font-src 'self' data: https://fonts.gstatic.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" }] }];
  },
  pageExtensions: ['js', 'jsx', 'ts', 'tsx'],
  productionBrowserSourceMaps: true,
  // Enhanced PWA Configuration with aggressive caching
  pwa: {
    dest: 'public',
    disable: process.env.NODE_ENV === 'development',
    register: true,
    skipWaiting: true,
    scope: '/',
    sw: 'sw.js',

    // Serve the offline page for navigations that cannot be served from the
    // network or the cache (see `public/offline.html`).
    fallbacks: {
      document: '/offline.html',
    },
    
    // Enhanced runtime caching with better strategies
    runtimeCaching: [
      // App shell: every navigation (marketplace listings, governance, docs,
      // dashboards) keeps its last successful response so the page can still be
      // opened while offline. A short network timeout keeps navigations snappy
      // on flaky connections instead of hanging.
      {
        urlPattern: ({ request }) => request.mode === 'navigate',
        handler: 'NetworkFirst',
        options: {
          cacheName: 'Trellis-pages',
          networkTimeoutSeconds: 4,
          expiration: {
            maxEntries: 60,
            maxAgeSeconds: 60 * 60 * 24 * 7, // 7 days
          },
          cacheableResponse: {
            statuses: [0, 200],
          },
        },
      },
      // Read-only API data (marketplace analytics, metrics, affiliate and
      // security summaries): answer instantly from cache and revalidate in the
      // background so offline pages keep showing the last known good data.
      {
        urlPattern: ({ request, url }) =>
          request.method === 'GET' &&
          /\/api\/(analytics|metrics|affiliates|security|operational-health|simulations)(\/|\?|$)/.test(
            url.href,
          ),
        handler: 'StaleWhileRevalidate',
        options: {
          cacheName: 'Trellis-read-api',
          expiration: {
            maxEntries: 150,
            maxAgeSeconds: 60 * 60 * 24 * 7, // 7 days
          },
          cacheableResponse: {
            statuses: [0, 200],
          },
        },
      },
      // Immutable Next.js build output: content hashed, safe to cache forever.
      {
        urlPattern: /^https?.*\/_next\/static\/.*/,
        handler: 'CacheFirst',
        options: {
          cacheName: 'Trellis-next-static',
          expiration: {
            maxEntries: 300,
            maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
          },
          cacheableResponse: {
            statuses: [0, 200],
          },
        },
      },
      {
        urlPattern: /^https?.*\/api\/.*$/,
        handler: 'NetworkFirst',
        options: {
          cacheName: 'Trellis-api',
          expiration: {
            maxEntries: 100,
            maxAgeSeconds: 60 * 60 * 24, // 24 hours
          },
          cacheableResponse: {
            statuses: [0, 200]
          },
          networkTimeoutSeconds: 10,
          cacheKeyWillBeUsed: async ({ request }) => {
            // Add build version to cache key for better cache busting
            const buildId = process.env.BUILD_ID || Date.now().toString();
            return `${request.url}?v=${buildId}`;
          },
        },
      },
      {
        urlPattern: /\.(?:js|css|html|json)$/,
        handler: 'StaleWhileRevalidate',
        options: {
          cacheName: 'Trellis-static',
          expiration: {
            maxEntries: 200,
            maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
          },
          cacheableResponse: {
            statuses: [0, 200]
          },
          cacheKeyWillBeUsed: async ({ request }) => {
            const buildId = process.env.BUILD_ID || Date.now().toString();
            return `${request.url}?v=${buildId}`;
          },
        },
      },
      {
        urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp|ico|avif)$/,
        handler: 'CacheFirst',
        options: {
          cacheName: 'Trellis-images',
          expiration: {
            maxEntries: 500,
            maxAgeSeconds: 60 * 60 * 24 * 90, // 90 days
          },
          cacheableResponse: {
            statuses: [0, 200]
          },
          cacheKeyWillBeUsed: async ({ request }) => {
            const buildId = process.env.BUILD_ID || Date.now().toString();
            return `${request.url}?v=${buildId}`;
          },
        },
      },
      {
        urlPattern: /\.(?:woff|woff2|ttf|eot)$/,
        handler: 'CacheFirst',
        options: {
          cacheName: 'Trellis-fonts',
          expiration: {
            maxEntries: 50,
            maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
          },
          cacheableResponse: {
            statuses: [0, 200]
          },
          cacheKeyWillBeUsed: async ({ request }) => {
            const buildId = process.env.BUILD_ID || Date.now().toString();
            return `${request.url}?v=${buildId}`;
          },
        },
      },
      {
        urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/,
        handler: 'StaleWhileRevalidate',
        options: {
          cacheName: 'Trellis-google-fonts-stylesheets',
          expiration: {
            maxEntries: 10,
            maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
          },
          cacheableResponse: {
            statuses: [0, 200]
          },
        },
      },
      {
        urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/,
        handler: 'CacheFirst',
        options: {
          cacheName: 'Trellis-google-fonts-webfonts',
          expiration: {
            maxEntries: 50,
            maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
          },
          cacheableResponse: {
            statuses: [0, 200]
          },
        },
      },
    ],
  },
  // Asset versioning for cache busting with build hash
  generateBuildId: async () => {
    // Create a more stable build ID based on content hash
    const crypto = await import('crypto');
    const fs = await import('fs');
    const path = await import('path');
    
    try {
      // Get package.json content for base hash
      const packageJsonPath = path.join(process.cwd(), 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      
      // Create hash from package version and timestamp
      const hashInput = `${packageJson.version}-${Date.now()}`;
      const hash = crypto.createHash('sha256').update(hashInput).digest('hex').substring(0, 8);
      
      return `build-${hash}`;
    } catch (error) {
      console.warn('Failed to generate build hash, using timestamp fallback');
      return `build-${Date.now()}`;
    }
  },
  // Enable compression
  compress: true,
  // Optimize images
  images: {
    domains: ['localhost'],
    formats: ['image/webp', 'image/avif'],
  },
  // Enable experimental features for better performance
  experimental: {
    optimizeCss: true,
    optimizePackageImports: ['@stellar/stellar-sdk', '@tanstack/react-query', '@mui/material', '@mui/icons-material', 'recharts', 'nft.storage', 'ipfs-http-client'],
  },
};

export default nextConfig;
