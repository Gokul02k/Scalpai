/* ScalpAI service worker.
 *
 * Its job is to make the dashboard installable as a real app, not to make it
 * fast. Chrome only mints an Android WebAPK — the thing that gets its own
 * launcher icon and drops the address bar — for a site that registers a
 * service worker with a fetch handler and can answer a navigation offline.
 *
 * The one rule that matters here: **prices are never served from cache.**
 *
 * A stale quote in a trading app is worse than no quote, because nothing on
 * screen says how old it is. A cached /api response would render as a live
 * price and could be acted on. So every /api request is network-only, and when
 * the network is gone the offline page deliberately shows no numbers at all
 * rather than the last dashboard we happened to see.
 *
 * Static assets are network-first rather than cache-first, which gives up some
 * speed for a property worth more: the app cannot get stuck on a stale JS
 * chunk after a rebuild. `next dev` reissues chunk URLs constantly, and a
 * cache-first worker would pin the phone to a dead bundle until someone found
 * the "clear site data" button.
 */

const VERSION = 'scalpai-v2';
const SHELL = `${VERSION}-shell`;
const OFFLINE_URL = '/offline.html';

/* Enough to render the offline page with its icon and nothing else. */
const PRECACHE = [
  OFFLINE_URL,
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // Individually, so one 404 during development cannot fail the whole
      // install and leave the app permanently uninstallable.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  /* Only GET is cacheable, and only our own origin is ours to decide about.
     Yahoo, Gemini and the engine are left entirely alone. */
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(liveOnly(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(pageOrOfflineNotice(request));
    return;
  }

  event.respondWith(freshOrCached(request, event));
});

/* Market data. Never cached, never substituted. When the network fails the
   dashboard's own error handling should run, so the failure is shaped like the
   JSON it expects rather than an HTML page it would choke on. */
async function liveOnly(request) {
  try {
    return await fetch(request);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'offline', message: 'No connection to ScalpAI.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }
}

/* Navigations. Network first; the offline page only when there is no network,
   and it shows no prices. */
async function pageOrOfflineNotice(request) {
  try {
    return await fetch(request);
  } catch (err) {
    const cache = await caches.open(SHELL);
    return (
      (await cache.match(OFFLINE_URL)) ||
      new Response('ScalpAI is offline.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      })
    );
  }
}

/* Everything else: scripts, styles, icons. Refresh the copy when the network
   answers, fall back to it when it does not.
 *
 * The write is handed to `event.waitUntil` rather than left to run on its own.
 * A bare `cache.put` is fire-and-forget, and the browser is free to shut the
 * worker down as soon as the response has been returned — so the copy that the
 * offline fallback depends on may never actually be written. */
async function freshOrCached(request, event) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      event.waitUntil(cache.put(request, response.clone()));
    }
    return response;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}
