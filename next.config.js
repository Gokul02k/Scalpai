/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,

  async headers() {
    return [
      {
        /* The service worker must never be held by a CDN.
         *
         * Vercel fronts everything in `public/` with its edge cache, and a
         * long-lived copy of sw.js would pin already-installed phones to an
         * old worker: the app has no address bar to reload from and no obvious
         * way to clear its own storage, so a bad version could stick for days.
         * Revalidating on every request costs one cheap round trip. */
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
        ],
      },
      {
        /* Same reasoning, lower stakes: this is where Chrome reads the icons
         * and name from when deciding whether to offer an install. */
        source: '/manifest.json',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
        ],
      },
      {
        source: '/offline.html',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
        ],
      },
    ];
  },
}

module.exports = nextConfig
