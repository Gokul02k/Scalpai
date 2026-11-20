export const dynamic = 'force-dynamic';

import { getAlertsEnabled, setAlertsEnabled } from '../../lib/alertSettings';
import { isAdmin, adminRequired } from '../../lib/adminAuth';

export async function GET(request) {
  const state = await getAlertsEnabled();
  // `admin` tells the page whether the token it sent would be accepted, so
  // Settings can say so before anyone presses a switch that will be refused.
  return Response.json(
    { ...state, admin: isAdmin(request) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function POST(request) {
  if (!isAdmin(request)) return adminRequired();

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (typeof body?.enabled !== 'boolean') {
    return Response.json({ error: 'Provide { enabled: boolean }' }, { status: 400 });
  }

  try {
    const state = await setAlertsEnabled(body.enabled);
    if (!state.configured) {
      return Response.json({ ...state, error: 'storage_not_configured' }, { status: 503 });
    }
    return Response.json(state);
  } catch (error) {
    console.error('alerts toggle:', error);
    return Response.json({ error: error.message || 'Failed to save' }, { status: 500 });
  }
}
