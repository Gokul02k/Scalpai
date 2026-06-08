export const metadata = {
  title: 'ScalpAI - Trading Dashboard',
  description: 'AI-powered scalping dashboard for NIFTY, SENSEX, BANK NIFTY',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, overflow: 'hidden' }}>
        {children}
      </body>
    </html>
  )
}
