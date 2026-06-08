export const THEMES = {
  dark: {
    bg: "#040810", card: "#070c18", border: "#131f35",
    green: "#00e676", red: "#ff1744", yellow: "#ffab00",
    blue: "#2979ff", text: "#dde6f0", muted: "#4e6278", dim: "#0e1828",
  },
  light: {
    bg: "#f0f4f8", card: "#ffffff", border: "#d0dae8",
    green: "#00a854", red: "#e53935", yellow: "#f59e00",
    blue: "#1565c0", text: "#1a2332", muted: "#5a6a7e", dim: "#e8eef4",
  },
};

export function cardStyle(C) {
  return { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 10 };
}
