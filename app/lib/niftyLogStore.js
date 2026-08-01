import { isUpstashConfigured, upstashCommand } from './upstash';

const LOG_KEY = 'scalpai:nifty-log';

export function isNiftyLogStorageConfigured() {
  return isUpstashConfigured();
}

export async function getNiftyLogs() {
  if (!isNiftyLogStorageConfigured()) {
    return { logs: [], configured: false };
  }

  try {
    const raw = await upstashCommand(['GET', LOG_KEY]);
    const logs = raw ? JSON.parse(raw) : [];
    return { logs: Array.isArray(logs) ? logs : [], configured: true };
  } catch (error) {
    console.error('niftyLogStore get:', error);
    return { logs: [], configured: true, error: error.message };
  }
}

export async function saveNiftyLogs(logs) {
  if (!isNiftyLogStorageConfigured()) return false;
  await upstashCommand(['SET', LOG_KEY, JSON.stringify(logs)]);
  return true;
}

export async function clearNiftyLogs() {
  if (!isNiftyLogStorageConfigured()) return false;
  await upstashCommand(['DEL', LOG_KEY]);
  return true;
}
