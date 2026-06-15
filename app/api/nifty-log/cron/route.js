export const dynamic = 'force-dynamic';
export const maxDuration = 30;

import { authorizeCron } from '../../../lib/cronAuth';
import { runNiftyLogTick } from '../../../lib/niftyLogTick';

export async function GET(request) {
  if (!authorizeCron(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runNiftyLogTick();
    return Response.json(result);
  } catch (error) {
    console.error('nifty-log cron:', error);
    return Response.json({ error: error.message || 'Cron tick failed' }, { status: 500 });
  }
}
