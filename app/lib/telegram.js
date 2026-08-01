const SEND_TIMEOUT_MS = 10000;

export function isTelegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

/** One bot can push to several chats — a personal DM and a group, say. */
function getChatIds() {
  return (process.env.TELEGRAM_CHAT_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

const esc = (v) => String(v)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const num = (v, digits = 2) => {
  const n = Number(v);
  if (v == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

const signed = (v, digits = 2) => {
  const n = Number(v);
  if (v == null || Number.isNaN(n)) return '—';
  return `${n >= 0 ? '+' : '−'}${num(Math.abs(n), digits)}`;
};

/**
 * Push a message to every configured chat. Never throws: a delivery failure
 * must not fail the tick that produced the signal.
 */
export async function sendTelegramMessage(text) {
  if (!isTelegramConfigured()) return { sent: false, reason: 'telegram_not_configured' };

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ids = getChatIds();
  if (!ids.length) return { sent: false, reason: 'no_chat_id' };

  const results = await Promise.all(ids.map(async (chatId) => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        cache: 'no-store',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        return { chatId, ok: false, error: data.description || `HTTP ${res.status}` };
      }
      return { chatId, ok: true };
    } catch (error) {
      return { chatId, ok: false, error: error.message || 'send failed' };
    }
  }));

  const delivered = results.filter((r) => r.ok).length;
  const failures = results.filter((r) => !r.ok);
  if (failures.length) console.error('telegram send:', failures);

  return {
    sent: delivered > 0,
    delivered,
    failed: failures.length,
    ...(failures.length ? { errors: failures.map((f) => f.error) } : {}),
  };
}

/** Render a logged NIFTY signal as the Telegram alert body. */
export function formatNiftySignalAlert(entry) {
  const isBuy = entry.action === 'BUY';
  const lines = [];

  lines.push(`${isBuy ? '🟢' : '🔴'} <b>${esc(entry.instrument || 'NIFTY')} ${esc(entry.action)}</b> · ${esc(entry.confidence)}% ${esc(entry.strength || '')}`.trim());
  if (entry.label) lines.push(esc(entry.label));
  lines.push('');

  lines.push(`Price   <b>${num(entry.price)}</b> (${signed(entry.chgPct)}%)`);
  lines.push(`Entry   ${num(entry.entry)}`);

  if (entry.entry != null && entry.target != null) {
    const pts = isBuy ? entry.target - entry.entry : entry.entry - entry.target;
    lines.push(`Target  ${num(entry.target)} (${signed(pts, 1)} pts)`);
  }
  if (entry.entry != null && entry.stopLoss != null) {
    const pts = isBuy ? entry.stopLoss - entry.entry : entry.entry - entry.stopLoss;
    lines.push(`Stop    ${num(entry.stopLoss)} (${signed(pts, 1)} pts)`);
  }
  if (entry.rr != null) lines.push(`R:R     ${num(entry.rr, 2)}`);

  const factors = (entry.factors || [])
    .filter((f) => f.type === entry.action)
    .sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))
    .slice(0, 4);
  if (factors.length) {
    lines.push('');
    lines.push('<b>Why</b>');
    for (const f of factors) {
      lines.push(`• ${esc(f.name)}${f.reason ? ` — ${esc(f.reason)}` : ''}`);
    }
  }

  const tech = entry.technical;
  if (tech) {
    const bits = [];
    if (tech.rsi != null) bits.push(`RSI ${num(tech.rsi, 1)}`);
    if (tech.macdHist != null) bits.push(`MACD ${signed(tech.macdHist, 2)}`);
    if (tech.liquidity) bits.push(esc(tech.liquidity));
    if (bits.length) {
      lines.push('');
      lines.push(bits.join(' · '));
    }
  }

  lines.push('');
  lines.push(`<i>${esc(entry.time)} IST · ${esc(entry.date)}</i>`);

  return lines.join('\n');
}

/** Setup-check message, so delivery can be verified outside market hours. */
export function formatTestAlert(context = {}) {
  const now = new Date();
  const stamp = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' });
  const lines = [
    '✅ <b>ScalpAI alerts are wired up</b>',
    '',
    'This is a test ping from your cron endpoint.',
    'Real alerts fire only for NIFTY BUY/SELL signals at 80%+ confidence during market hours.',
    '',
    `Signal storage: ${context.storage ? 'configured' : '<b>NOT configured</b>'}`,
    `Background alerts: ${context.enabled === false ? '<b>OFF</b> — turn the toggle on in Settings' : 'on'}`,
    `Market: ${esc(context.market || 'unknown')}`,
    '',
    `<i>${esc(stamp)} IST</i>`,
  ];
  return lines.join('\n');
}
