/**
 * Who may change shared server state: the NIFTY log and the alerts switch.
 *
 * Server-side only. Import from route handlers.
 *
 * These routes used to accept writes from anyone, so any visitor to a public
 * deployment could wipe the owner's signal log, push invented entries into it,
 * or switch the owner's Telegram alerts off. Reading stays open — the log is
 * what the dashboard shows everybody — but writing now needs `ADMIN_TOKEN`,
 * typed once into Settings on the owner's own device.
 *
 * With no token configured, writes are allowed only in local development, the
 * same rule `cronAuth.js` applies to `CRON_SECRET`.
 */

import { timingSafeEqual } from 'node:crypto';

export const ADMIN_HEADER = 'x-scalpai-admin';

export function adminTokenConfigured() {
  return Boolean(process.env.ADMIN_TOKEN?.trim());
}

function sameSecret(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function isAdmin(request) {
  const secret = process.env.ADMIN_TOKEN?.trim();
  if (!secret) return process.env.NODE_ENV === 'development';
  const supplied = request.headers.get(ADMIN_HEADER)?.trim();
  return Boolean(supplied) && sameSecret(supplied, secret);
}

/** A 401 the page can recognise and turn into "add your admin token". */
export function adminRequired() {
  return Response.json(
    {
      ok: false,
      error: adminTokenConfigured()
        ? 'Admin token missing or wrong. Add it in Settings → Background alerts.'
        : 'Set ADMIN_TOKEN on the server to allow changes from the dashboard.',
      needsAdmin: true,
    },
    { status: 401 }
  );
}
