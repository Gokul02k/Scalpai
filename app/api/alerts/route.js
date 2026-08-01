export const dynamic = 'force-dynamic';

import { getAlertsEnabled, setAlertsEnabled } from '../../lib/alertSettings';

export async function GET() {
  const state = await getAlertsEnabled();
  return Response.json(state, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request) {
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
