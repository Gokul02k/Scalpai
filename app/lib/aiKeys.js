/**
 * Where a key typed into the settings page lives, in the browser only.
 *
 * The dashboard has no accounts and no server-side store, so there is nowhere
 * to keep a key for somebody. It stays on the device that typed it and travels
 * to `/api/chat` and `/api/ea` in the request body, which are the only two
 * routes that talk to a model.
 *
 * Two stores, chosen by whether the box was ticked:
 *
 *   - **remembered** — `localStorage`, survives closing the tab
 *   - **this session** — `sessionStorage`, gone when the tab closes
 *
 * A key lives in exactly one of them. Saving moves it rather than copying it,
 * so un-ticking "remember" genuinely stops it surviving a restart instead of
 * leaving a stale copy behind that the page would keep finding.
 *
 * Kept out of the `scalpai-v1` blob that holds the portfolio and settings on
 * purpose. That blob is read, rewritten and exported as one object, and a
 * secret riding inside it would be copied by anything that ever copies it.
 */

import { AI_PROVIDER_IDS, isPlaceholderKey } from './aiProviders';

const STORE = 'scalpai-ai-keys';

function read(storage) {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window[storage]?.getItem(STORE);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function write(storage, data) {
  if (typeof window === 'undefined') return;
  try {
    const keys = Object.keys(data);
    if (!keys.length) window[storage]?.removeItem(STORE);
    else window[storage]?.setItem(STORE, JSON.stringify(data));
  } catch {
    /* Private mode, or a full quota. A key that cannot be stored is still
       usable for this render; failing loudly here would block the chat. */
  }
}

/**
 * Every key this browser holds, as `{ gemini: 'AIza…', groq: '…' }`.
 *
 * Remembered keys are read first so a session key typed afterwards wins, which
 * matches what the page shows.
 */
export function loadAiKeys() {
  const merged = { ...read('localStorage'), ...read('sessionStorage') };
  const out = {};
  for (const id of AI_PROVIDER_IDS) {
    const value = typeof merged[id] === 'string' ? merged[id].trim() : '';
    if (value && !isPlaceholderKey(value)) out[id] = value;
  }
  return out;
}

/** Which store each held key came from, for the settings page to render. */
export function loadAiKeyMeta() {
  const remembered = read('localStorage');
  const session = read('sessionStorage');
  const out = {};
  for (const id of AI_PROVIDER_IDS) {
    if (typeof session[id] === 'string' && session[id].trim()) {
      out[id] = { remembered: false };
    } else if (typeof remembered[id] === 'string' && remembered[id].trim()) {
      out[id] = { remembered: true };
    }
  }
  return out;
}

export function saveAiKey(id, key, remember) {
  if (!AI_PROVIDER_IDS.includes(id)) return;
  const value = (key || '').trim();
  if (!value) return clearAiKey(id);

  const keep = remember ? 'localStorage' : 'sessionStorage';
  const drop = remember ? 'sessionStorage' : 'localStorage';

  const target = read(keep);
  target[id] = value;
  write(keep, target);

  const other = read(drop);
  if (id in other) {
    delete other[id];
    write(drop, other);
  }
}

export function clearAiKey(id) {
  for (const storage of ['localStorage', 'sessionStorage']) {
    const data = read(storage);
    if (id in data) {
      delete data[id];
      write(storage, data);
    }
  }
}

export function clearAllAiKeys() {
  write('localStorage', {});
  write('sessionStorage', {});
}
