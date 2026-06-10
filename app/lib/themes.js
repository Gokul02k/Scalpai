// Design tokens. NOTE: bg, card, border, green, red, yellow, blue, text, muted, dim
// MUST stay as 6-digit hex — the UI appends alpha like `${C.green}22`.
// glass/glassBorder/bgGrad/shadow/glow are used directly (never concatenated).
export const THEMES = {
  dark: {
    bg: "#05070f",
    bgGrad:
      "radial-gradient(1100px 520px at 50% -8%, rgba(41,121,255,0.16), transparent 60%), radial-gradient(900px 480px at 100% 0%, rgba(0,230,118,0.08), transparent 55%), linear-gradient(180deg, #05070f 0%, #04060c 100%)",
    card: "#0a1020",
    glass: "rgba(16, 24, 44, 0.55)",
    glassStrong: "rgba(12, 18, 34, 0.82)",
    glassBorder: "rgba(124, 156, 224, 0.16)",
    border: "#16223c",
    green: "#1fe3a0",
    red: "#ff4d6d",
    yellow: "#ffc04d",
    blue: "#5b8dff",
    text: "#e8eef9",
    muted: "#6f83a4",
    dim: "#111a2e",
    shadow: "0 10px 34px rgba(0,0,0,0.5)",
    glow: "0 0 26px",
  },
  light: {
    bg: "#eef2f8",
    bgGrad:
      "radial-gradient(1100px 520px at 50% -8%, rgba(21,101,192,0.12), transparent 60%), radial-gradient(900px 480px at 100% 0%, rgba(0,168,84,0.08), transparent 55%), linear-gradient(180deg, #f3f6fb 0%, #e7edf6 100%)",
    card: "#ffffff",
    glass: "rgba(255, 255, 255, 0.72)",
    glassStrong: "rgba(255, 255, 255, 0.9)",
    glassBorder: "rgba(21, 101, 192, 0.14)",
    border: "#d3dceb",
    green: "#00a85a",
    red: "#e5394f",
    yellow: "#e08a00",
    blue: "#1565c0",
    text: "#13203a",
    muted: "#5d6e88",
    dim: "#e9eff7",
    shadow: "0 10px 30px rgba(31,58,110,0.12)",
    glow: "0 0 22px",
  },
};

/** Glass card surface used across the app. */
export function cardStyle(C) {
  return {
    background: C.glass,
    backdropFilter: "blur(16px) saturate(140%)",
    WebkitBackdropFilter: "blur(16px) saturate(140%)",
    border: `1px solid ${C.glassBorder}`,
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
    boxShadow: C.shadow,
  };
}

/** Stronger glass for sticky chrome (header, nav, modals). */
export function glassStyle(C) {
  return {
    background: C.glassStrong,
    backdropFilter: "blur(20px) saturate(150%)",
    WebkitBackdropFilter: "blur(20px) saturate(150%)",
    border: `1px solid ${C.glassBorder}`,
  };
}
