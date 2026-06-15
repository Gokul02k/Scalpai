export const dynamic = 'force-dynamic';

import {
  applyNiftyLogUpdate,
  mergeNiftyLogLists,
} from '../../lib/signalLog';
import {
  getNiftyLogs,
  saveNiftyLogs,
  clearNiftyLogs,
  isNiftyLogStorageConfigured,
} from '../../lib/niftyLogStore';

export async function GET() {
  const { logs, configured, error } = await getNiftyLogs();
  return Response.json(
    { logs, configured, backgroundLogging: configured, error: error ?? null },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request) {
  if (!isNiftyLogStorageConfigured()) {
    return Response.json({ ok: false, reason: 'storage_not_configured' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const { entry, logs: clientLogs } = body || {};

  if (entry) {
    const { logs: existing } = await getNiftyLogs();
    const { logs, changed } = applyNiftyLogUpdate(existing, entry);
    if (changed) await saveNiftyLogs(logs);
    return Response.json({ ok: true, changed, logCount: logs.length });
  }

  if (Array.isArray(clientLogs)) {
    const { logs: serverLogs } = await getNiftyLogs();
    const merged = mergeNiftyLogLists(serverLogs, clientLogs);
    await saveNiftyLogs(merged);
    return Response.json({ ok: true, logCount: merged.length });
  }

  return Response.json({ ok: false, error: 'Provide entry or logs' }, { status: 400 });
}

export async function DELETE() {
  if (!isNiftyLogStorageConfigured()) {
    return Response.json({ ok: true, configured: false });
  }
  await clearNiftyLogs();
  return Response.json({ ok: true });
}
