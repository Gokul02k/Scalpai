/**
 * The owner's admin token, kept on the device that typed it.
 *
 * Sent as a header on the requests that change shared server state (the NIFTY
 * log and the alerts switch). Stored apart from the `scalpai-v1` blob for the
 * same reason the AI keys are: that blob is read and rewritten whole, and a
 * secret riding inside it gets copied by anything that copies it.
 */

const STORE = 'scalpai-admin-token';
export const ADMIN_HEADER = 'x-scalpai-admin';

export function loadAdminToken() {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(STORE)?.trim() || '';
  } catch {
    return '';
  }
}

export function saveAdminToken(token) {
  if (typeof window === 'undefined') return;
  try {
    const value = (token || '').trim();
    if (value) window.localStorage.setItem(STORE, value);
    else window.localStorage.removeItem(STORE);
  } catch {
    /* Private mode or full quota: the token still works for this session. */
  }
}

/** Headers for a write request; empty when no token is held. */
export function adminHeaders(token) {
  return token ? { [ADMIN_HEADER]: token } : {};
}
