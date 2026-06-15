const LOG_KEY = 'scalpai:nifty-log';

export function isNiftyLogStorageConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function upstashCommand(command) {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    cache: 'no-store',
  });

  if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
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
