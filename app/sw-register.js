'use client';

import { useEffect } from 'react';

/* Registers the service worker, which is what lets Chrome install the
 * dashboard as an app instead of a bookmark.
 *
 * Renders nothing. It is mounted from the root layout so registration happens
 * once per load, on every route.
 *
 * The explanatory branch below is not padding: `serviceWorker` is simply
 * absent on an insecure origin, so opening the dashboard at
 * http://<lan-ip>:3000 on a phone fails here with no error of its own. That
 * silence is exactly what makes "why is there no install option?" hard to
 * diagnose, so it says so.
 */
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) {
      if (!window.isSecureContext) {
        console.info(
          '[ScalpAI] Not installable: %s is not a secure origin. Chrome only ' +
            'allows service workers and app install over HTTPS (or on ' +
            'localhost), so "Add to Home Screen" here makes a browser ' +
            'shortcut rather than an app. Serve the dashboard over HTTPS to ' +
            'install it properly.',
          window.location.origin,
        );
      }
      return;
    }

    let cancelled = false;

    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        if (cancelled) return;

        // Take a new worker as soon as one is waiting. Without this the phone
        // keeps running the previous version until every tab is closed, which
        // for an installed app can be days.
        registration.addEventListener('updatefound', () => {
          const next = registration.installing;
          if (!next) return;
          next.addEventListener('statechange', () => {
            if (next.state === 'installed' && navigator.serviceWorker.controller) {
              next.postMessage('skip-waiting');
            }
          });
        });
      })
      .catch((err) => {
        console.warn('[ScalpAI] service worker registration failed:', err);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
