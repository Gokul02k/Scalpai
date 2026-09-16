import ServiceWorkerRegistrar from './sw-register';

export const metadata = {
  title: 'ScalpAI - Trading Dashboard',
  description: 'AI-powered scalping dashboard for NIFTY, SENSEX, BANK NIFTY',
  manifest: '/manifest.json',
  applicationName: 'ScalpAI',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'ScalpAI',
  },
  icons: {
    icon: [
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/icons/apple-touch-icon.png',
  },
  formatDetection: {
    telephone: false,
  },
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  /* Matches the manifest's theme_color so the Android status bar blends into
     the dashboard instead of banding across the top of it. */
  themeColor: '#040810',
  /* Lets the layout reach under the notch and the home indicator, which is
     most of what separates an installed app from a page in a browser. */
  viewportFit: 'cover',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  )
}
