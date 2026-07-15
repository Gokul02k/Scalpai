"use client";

import { useState, useEffect, useRef, useMemo, useCallback, memo } from "react";
import {
  AreaChart, Area, BarChart, Bar, Cell, YAxis,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  Settings, ChevronRight, MessageCircle, X, Send, Newspaper,
  Briefcase, Home, ArrowUp, ArrowDown, Zap, RefreshCw,
  Upload, Plus, Trash2, Bell, Sun, Moon, Lightbulb, ScrollText,
} from "lucide-react";
import {
  fetchAllMarketData, fetchCandles, fetchStockCandles, fetchPortfolioPrices, fetchNews, fetchStockQuote, fetchStockFundamentals, genFallbackCandles, SYMBOL_MAP,
} from "./lib/marketData";
import { analyzeFromCandles } from "./lib/indicators";
import { generateIndexSignals, generatePortfolioSignals, parsePortfolioCSV } from "./lib/signals";
import { buildUnifiedSuggestion, explainAssetMove, getPortfolioSuggestion } from "./lib/suggestion";
import { loadPersisted, savePersisted } from "./lib/storage";
import {
  buildNiftySignalLogEntry,
  applyNiftyLogUpdate,
  applyOutcomeToLogs,
  summarizeOutcomes,
  mergeNiftyLogLists,
  isLoggableNiftySignal,
  OUTCOME_LABELS,
  NIFTY_LOG_MAX_ENTRIES,
  NIFTY_LOG_MIN_CONFIDENCE,
  NIFTY_MIN_PASS_POINTS,
  evaluateSignalOutcome,
  buildPortfolioSignalLogEntry,
  applyPortfolioLogUpdate,
  PORTFOLIO_LOG_MIN_CONFIDENCE,
  PORTFOLIO_EVAL_WINDOW_MS,
} from "./lib/signalLog";
import { getMarketStatus } from "./lib/marketHours";
import { THEMES, cardStyle, glassStyle } from "./lib/themes";
import { GEMINI_CHAT_MODELS, DEFAULT_GEMINI_MODEL } from "./lib/geminiModels";

const INSTRUMENTS = {
  "NIFTY":  { base: 25000, vol: 0.0012, lot: 50 },
  "GOLD":   { base: 124,   vol: 0.0015, lot: 1 },
  "SILVER": { base: 228,   vol: 0.0020, lot: 1 },
};

const INSTRUMENT_KEYS = Object.keys(INSTRUMENTS);

const INSTRUMENT_SUB = {
  NIFTY: "Scalping · NSE Index",
  GOLD: "NSE · GOLDBEES ETF",
  SILVER: "NSE · SILVERBEES ETF",
};

const MACRO_SYMBOLS = new Set(["NIFTY", "GOLD", "SILVER", "GOLDBEES", "SILVERBEES", "SENSEX", "BANKNIFTY"]);

const DEFAULT_PORTFOLIO = [];

const NIFTY50_SAMPLE = [
  "RELIANCE","TCS","HDFCBANK","INFY","ICICIBANK","HINDUNILVR","ITC","SBIN","BHARTIARTL",
  "KOTAKBANK","LT","AXISBANK","ASIANPAINT","MARUTI","TITAN","BAJFINANCE","SUNPHARMA","WIPRO",
  "ULTRACEMCO","NESTLEIND","POWERGRID","NTPC","ONGC","M&M","TATASTEEL","ADANIENT","JSWSTEEL",
  "HCLTECH","TECHM","INDUSINDBK","BAJAJFINSV","CIPLA","DRREDDY","GRASIM","APOLLOHOSP","EICHERMOT",
  "HEROMOTOCO","BRITANNIA","DIVISLAB","COALINDIA","BPCL","HINDALCO","TATACONSUM","SBILIFE",
  "HDFCLIFE","SHREECEM","TATAMOTORS","ADANIPORTS","UPL",
];

const DEFAULT_WATCHLISTS = {
  "My Watchlist": ["RELIANCE", "TCS", "HDFCBANK"],
  "NIFTY Heavyweights": ["RELIANCE", "HDFCBANK", "INFY", "ICICIBANK", "TCS"],
  "NIFTY 50": NIFTY50_SAMPLE,
};

const STOCK_UNIVERSE = [...new Set([
  ...NIFTY50_SAMPLE,
  ...Object.values(DEFAULT_WATCHLISTS).flat(),
  "NIFTY", "BANKNIFTY", "SENSEX",
])].sort();

function filterStockSuggestions(query, exclude = [], limit = 8) {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const excluded = new Set(exclude.map((s) => s.toUpperCase()));
  return STOCK_UNIVERSE
    .filter((s) => !excluded.has(s) && s.includes(q))
    .sort((a, b) => {
      const aPrefix = a.startsWith(q) ? 0 : 1;
      const bPrefix = b.startsWith(q) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      return a.localeCompare(b);
    })
    .slice(0, limit);
}

function sortPortfolioSuggestions(items) {
  const group = (action) => (action === "BUY" ? 0 : action === "SELL" ? 1 : 2);
  return [...items].sort((a, b) => {
    const g = group(a.action) - group(b.action);
    if (g !== 0) return g;
    return (b.confidence || 0) - (a.confidence || 0);
  });
}

function latestNewsHeadline(name, newsList = []) {
  const sym = name.toUpperCase();
  const item = newsList.find(
    (n) => (n.stocks || []).some((s) => String(s).toUpperCase() === sym)
      || (n.headline || "").toUpperCase().includes(sym)
  );
  return item?.headline || null;
}

function pushSuggestionItem(items, { id, name, mode, call, priceData, newsHeadline }) {
  if (!call || call.action === "WAIT" || !call.confidence) return;
  const dayPct = priceData?.prev
    ? +(((priceData.cur - priceData.prev) / priceData.prev) * 100).toFixed(2)
    : 0;
  const reason = call.factors?.[0]?.reason
    || call.reason?.split(" · ")[0]
    || call.label;
  items.push({
    id,
    name,
    mode,
    action: call.action,
    label: call.label,
    confidence: call.confidence,
    reason,
    price: priceData?.cur,
    dayPct,
    entry: call.entry,
    target: call.target,
    stopLoss: call.stopLoss,
    rr: call.rr,
    newsHeadline: (call.action === "BUY" || call.action === "SELL") ? newsHeadline : null,
  });
}

const fmt  = (n, d = 2) => n?.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }) ?? "—";
const fmtD = (n) => (n >= 0 ? "+" : "") + fmt(n);
function initPrices() {
  const p = {};
  Object.entries(INSTRUMENTS).forEach(([k, v]) => {
    const prev = +(v.base * (1 + (Math.random() - 0.5) * 0.006)).toFixed(2);
    p[k] = { cur: v.base, open: +(v.base * 0.999).toFixed(2), high: +(v.base * 1.007).toFixed(2), low: +(v.base * 0.993).toFixed(2), prev };
  });
  return p;
}

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch (_) {}
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function CandleChart({ candles = [], height = 200, C, overlays = null }) {
  if (!candles.length) return null;
  const W = 800, PAD = 10, H = height, ch = H - PAD * 2;
  const maxP = Math.max(...candles.map((c) => c.h));
  const minP = Math.min(...candles.map((c) => c.l));
  const range = maxP - minP || 1;
  const toY = (p) => PAD + ((maxP - p) / range) * ch;
  const sw = W / candles.length;
  const bw = Math.max(2, sw * 0.6);
  const inRange = (p) => p != null && p >= minP && p <= maxP;

  // Horizontal overlay lines (EMA / support / resistance / last price). Lines don't
  // distort under preserveAspectRatio="none"; labels are rendered in the legend below.
  const levelLines = overlays
    ? [
        { v: overlays.ema20, c: C.blue, dash: "5 4" },
        { v: overlays.ema50, c: C.yellow, dash: "5 4" },
        { v: overlays.support, c: C.green, dash: "2 4" },
        { v: overlays.resistance, c: C.red, dash: "2 4" },
        { v: overlays.price, c: overlays.priceUp ? C.green : C.red, dash: "0" },
      ].filter((l) => inRange(l.v))
    : [];

  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block" }}>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={0} y1={PAD + f * ch} x2={W} y2={PAD + f * ch} stroke={C.border} strokeWidth={0.6} />
      ))}
      {levelLines.map((l, i) => (
        <line key={`lvl-${i}`} x1={0} y1={toY(l.v)} x2={W} y2={toY(l.v)} stroke={l.c} strokeWidth={l.dash === "0" ? 1.4 : 1} strokeDasharray={l.dash === "0" ? undefined : l.dash} opacity={l.dash === "0" ? 0.9 : 0.55} />
      ))}
      {candles.map((c, i) => {
        const up = c.c >= c.o, clr = up ? C.green : C.red;
        const cx = i * sw + sw / 2;
        const bt = toY(Math.max(c.o, c.c)), bb = toY(Math.min(c.o, c.c));
        return (
          <g key={i}>
            <line x1={cx} y1={toY(c.h)} x2={cx} y2={toY(c.l)} stroke={clr} strokeWidth={1} opacity={0.7} />
            <rect x={cx - bw / 2} y={bt} width={bw} height={Math.max(1, bb - bt)} fill={clr} opacity={up ? 1 : 0.85} rx={0.5} />
          </g>
        );
      })}
    </svg>
  );
}

function ChartLegend({ overlays, decimals, C }) {
  if (!overlays) return null;
  const items = [
    { l: "Price", v: overlays.price, c: overlays.priceUp ? C.green : C.red },
    { l: "EMA20", v: overlays.ema20, c: C.blue },
    { l: "EMA50", v: overlays.ema50, c: C.yellow },
    { l: "Support", v: overlays.support, c: C.green },
    { l: "Resistance", v: overlays.resistance, c: C.red },
  ].filter((x) => x.v != null);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
      {items.map((x) => (
        <div key={x.l} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 14, height: 3, borderRadius: 2, background: x.c, display: "inline-block" }} />
          <span style={{ color: C.muted, fontSize: 10 }}>{x.l}</span>
          <span style={{ color: C.text, fontSize: 11, fontWeight: 700 }}>{fmt(x.v, decimals)}</span>
        </div>
      ))}
    </div>
  );
}

function SignalCard({ sig, price, C }) {
  const buy = sig.type === "BUY";
  const target = sig.target ?? +(price * (buy ? 1.009 : 0.991)).toFixed(2);
  const sl = sig.stopLoss ?? +(price * (buy ? 0.994 : 1.006)).toFixed(2);
  const rr = sig.rr ?? (Math.abs(target - price) / Math.abs(price - sl)).toFixed(1);
  const clr = buy ? C.green : C.red;
  return (
    <div style={{ background: `${clr}0d`, border: `1px solid ${clr}45`, borderRadius: 12, padding: 13, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ background: clr, color: "#000", fontWeight: 800, fontSize: 10, padding: "2px 9px", borderRadius: 4 }}>{sig.type}</span>
          <span style={{ color: C.muted, fontSize: 11, fontWeight: 600 }}>{sig.str}</span>
          {sig.instrument && <span style={{ color: C.blue, fontSize: 10, fontWeight: 700 }}>{sig.instrument}</span>}
        </div>
        <span style={{ color: clr, fontWeight: 800, fontSize: 13 }}>{sig.prob}%</span>
      </div>
      <p style={{ color: C.text, fontSize: 12, lineHeight: 1.45, margin: "0 0 9px" }}>{sig.reason}</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 5 }}>
        {[
          { l: "Entry", v: fmt(price), c: C.blue },
          { l: "Target", v: fmt(target), c: C.green },
          { l: "Stop Loss", v: fmt(sl), c: C.red },
          { l: "R:R", v: `1:${rr}`, c: C.yellow },
        ].map((x) => (
          <div key={x.l} style={{ background: C.dim, borderRadius: 6, padding: "6px 3px", textAlign: "center" }}>
            <div style={{ color: C.muted, fontSize: 9, marginBottom: 2, textTransform: "uppercase" }}>{x.l}</div>
            <div style={{ color: x.c, fontWeight: 800, fontSize: 11 }}>{x.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NewsCard({ n, onClick, C }) {
  const sc = n.sentiment === "positive" ? C.green : n.sentiment === "negative" ? C.red : C.yellow;
  const ic = n.impact === "HIGH" ? C.red : n.impact === "MEDIUM" ? C.yellow : C.muted;
  return (
    <div onClick={() => onClick(n)} style={{ ...cardStyle(C), cursor: "pointer", padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ background: `${sc}22`, color: sc, fontSize: 10, padding: "2px 7px", borderRadius: 4, fontWeight: 700 }}>{n.cat}</span>
        <div style={{ display: "flex", gap: 8 }}>
          <span style={{ color: ic, fontSize: 10, fontWeight: 700 }}>⚡{n.impact}</span>
          <span style={{ color: C.muted, fontSize: 10 }}>{n.time}</span>
        </div>
      </div>
      <p style={{ color: C.text, fontSize: 13, lineHeight: 1.45, margin: "0 0 6px" }}>{n.headline}</p>
      {n.marketImpact && (
        <p style={{ color: C.muted, fontSize: 11, lineHeight: 1.4, margin: "0 0 8px", borderLeft: `2px solid ${sc}`, paddingLeft: 8 }}>
          📈 Market impact: {n.marketImpact}
        </p>
      )}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {(n.stocks || []).slice(0, 3).map((s) => (
          <span key={s} style={{ background: C.dim, color: C.muted, fontSize: 10, padding: "2px 6px", borderRadius: 4 }}>{s}</span>
        ))}
      </div>
    </div>
  );
}

function Toggle({ on, onToggle, C }) {
  return (
    <button onClick={onToggle} style={{ width: 46, height: 26, borderRadius: 13, background: on ? C.green : C.dim, border: "none", cursor: "pointer", position: "relative", flexShrink: 0 }}>
      <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: on ? 23 : 3, transition: "left .2s", boxShadow: "0 1px 4px rgba(0,0,0,.4)" }} />
    </button>
  );
}

/** RSI / MACD / Volume + BB / EMA — memoized so live price ticks don't remount charts. */
const ChartIndicatorPanels = memo(function ChartIndicatorPanels({ analysis, instCandles, sett, C, S }) {
  const rsiData = analysis?.rsiHist ?? [];
  const macdData = analysis?.macdHist ?? [];
  const volData = useMemo(() => instCandles.slice(-20), [instCandles]);
  const chartBox = { width: "100%", height: 80, minHeight: 80 };

  return (
    <>
      {sett.ind.rsi && (
        <div style={S.card}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
            RSI (14) — {analysis?.rsi ?? "—"}
          </div>
          <div style={chartBox}>
            {rsiData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={rsiData} margin={{ top: 5, right: 0, left: -30, bottom: 0 }}>
                  <YAxis domain={[0, 100]} tick={{ fill: C.muted, fontSize: 10 }} />
                  <ReferenceLine y={70} stroke={C.red} strokeDasharray="3 3" />
                  <ReferenceLine y={30} stroke={C.green} strokeDasharray="3 3" />
                  <Area type="monotone" dataKey="rsi" stroke={C.yellow} fill={`${C.yellow}22`} dot={false} strokeWidth={1.5} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 11 }}>Loading RSI…</div>
            )}
          </div>
        </div>
      )}

      {sett.ind.macd && (
        <div style={S.card}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
            MACD — <span style={{ color: (analysis?.macd?.h ?? 0) >= 0 ? C.green : C.red }}>{analysis?.macd?.h ?? "—"}</span>
            {analysis?.macd && (
              <span style={{ color: C.muted, fontWeight: 400, fontSize: 11 }}> ({analysis.macd.h >= 0 ? "bullish" : "bearish"})</span>
            )}
          </div>
          <div style={{ ...chartBox, height: 70, minHeight: 70 }}>
            {macdData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={macdData} margin={{ top: 0, right: 0, left: -30, bottom: 0 }}>
                  <ReferenceLine y={0} stroke={C.border} />
                  <Bar dataKey="h" radius={[2, 2, 0, 0]} isAnimationActive={false}>
                    {macdData.map((d, i) => (
                      <Cell key={i} fill={d.h >= 0 ? C.green : C.red} opacity={0.7} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 11 }}>Loading MACD…</div>
            )}
          </div>
        </div>
      )}

      {sett.ind.vol && (
        <div style={S.card}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Volume</div>
          <div style={{ ...chartBox, height: 70, minHeight: 70 }}>
            {volData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={volData} margin={{ top: 0, right: 0, left: -30, bottom: 0 }}>
                  <Bar dataKey="vol" fill={C.blue} opacity={0.65} radius={[2, 2, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 11 }}>Loading volume…</div>
            )}
          </div>
        </div>
      )}

      {sett.ind.bb && analysis && (
        <div style={S.card}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Bollinger Bands</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, textAlign: "center" }}>
            {[{ l: "Upper", v: analysis.bb.upper, c: C.red }, { l: "Mid", v: analysis.bb.mid, c: C.yellow }, { l: "Lower", v: analysis.bb.lower, c: C.green }].map((x) => (
              <div key={x.l} style={{ background: C.dim, borderRadius: 8, padding: 10 }}>
                <div style={{ color: C.muted, fontSize: 10 }}>{x.l}</div>
                <div style={{ color: x.c, fontWeight: 800, fontSize: 14 }}>{fmt(x.v)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {(sett.ind.ema20 || sett.ind.ema50) && analysis && (
        <div style={S.card}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>EMA Values</div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {sett.ind.ema20 && <span style={{ color: C.muted, fontSize: 12 }}>EMA 20: <b style={{ color: C.blue }}>{fmt(analysis.ema20)}</b></span>}
            {sett.ind.ema50 && <span style={{ color: C.muted, fontSize: 12 }}>EMA 50: <b style={{ color: C.yellow }}>{fmt(analysis.ema50)}</b></span>}
          </div>
        </div>
      )}

      {analysis && (
        <div style={S.card}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Technical Summary</div>
          {analysis.summary.map((row) => (
            <div key={row.n} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.dim}` }}>
              <div>
                <div style={{ color: C.text, fontSize: 12, fontWeight: 600 }}>{row.n}</div>
                <div style={{ color: C.muted, fontSize: 10 }}>{row.sig}</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ color: C.muted, fontSize: 11 }}>{row.v}</span>
                <span style={{ background: row.t === "BUY" ? `${C.green}22` : row.t === "SELL" ? `${C.red}22` : `${C.muted}22`, color: row.t === "BUY" ? C.green : row.t === "SELL" ? C.red : C.muted, padding: "2px 9px", borderRadius: 4, fontSize: 10, fontWeight: 800 }}>{row.t}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
});

function SignalFactorRow({ factor, C }) {
  const clr = factor.type === "BUY" ? C.green : factor.type === "SELL" ? C.red : C.muted;
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 0", borderBottom: `1px solid ${C.dim}` }}>
      <span style={{ background: `${clr}22`, color: clr, fontSize: 9, fontWeight: 800, padding: "2px 7px", borderRadius: 4, flexShrink: 0, minWidth: 36, textAlign: "center" }}>
        {factor.type}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: C.text, fontSize: 12, fontWeight: 600 }}>{factor.name}</div>
        <div style={{ color: C.muted, fontSize: 11, lineHeight: 1.4 }}>{factor.reason}</div>
      </div>
    </div>
  );
}

function OutcomeBadge({ outcome, C }) {
  const status = outcome?.status || "pending";
  const map = {
    target: { c: C.green, txt: `✓ ${OUTCOME_LABELS.target}` },
    stop: { c: C.red, txt: `✗ ${OUTCOME_LABELS.stop}` },
    expired: { c: C.muted, txt: OUTCOME_LABELS.expired },
    pending: { c: C.yellow, txt: `● ${OUTCOME_LABELS.pending}` },
  };
  const o = map[status] || map.pending;
  return (
    <span style={{ background: `${o.c}22`, color: o.c, fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 4, border: `1px solid ${o.c}55` }}>
      {o.txt}
    </span>
  );
}

function NiftySignalLogRow({ entry, C, S }) {
  const [open, setOpen] = useState(false);
  const clr = entry.action === "BUY" ? C.green : C.red;
  const strengthClr = entry.strengthTier >= 3 ? C.green : entry.strengthTier >= 2 ? C.yellow : C.muted;
  const outcome = entry.outcome;
  const resultClr = outcome ? (outcome.resultPct > 0 ? C.green : outcome.resultPct < 0 ? C.red : C.muted) : C.muted;

  return (
    <div style={{ ...S.card, borderColor: `${clr}44`, marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ background: clr, color: "#000", fontSize: 10, fontWeight: 800, padding: "3px 10px", borderRadius: 4 }}>{entry.action}</span>
            <OutcomeBadge outcome={outcome} C={C} />
            <span style={{ background: `${strengthClr}22`, color: strengthClr, fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 4 }}>{entry.strength}</span>
            <span style={{ color: C.text, fontSize: 12, fontWeight: 800 }}>{entry.confidence}%</span>
            {entry.peakConfidence > entry.confidence && (
              <span style={{ color: C.muted, fontSize: 10, fontWeight: 700 }}>peak {entry.peakConfidence}%</span>
            )}
          </div>
          <div style={{ color: C.muted, fontSize: 11 }}>
            {entry.date} · {entry.firstTime && entry.firstTime !== entry.time ? `${entry.firstTime}–${entry.time}` : entry.time}
            {entry.updates > 1 && ` · ${entry.updates}×`}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>₹{fmt(entry.price, 0)}</div>
          <div style={{ color: entry.chgPct >= 0 ? C.green : C.red, fontSize: 11, fontWeight: 700 }}>
            {entry.chgPct >= 0 ? "+" : ""}{entry.chgPct}%
          </div>
        </div>
      </div>

      {outcome && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, background: `${resultClr}12`, borderRadius: 8, padding: "7px 10px", marginBottom: 8 }}>
          <span style={{ color: C.muted, fontSize: 11 }}>
            {outcome.status === "target" && "Target hit"}
            {outcome.status === "stop" && "Stopped out"}
            {outcome.status === "expired" && "Expired (no target/stop)"}
            {outcome.status === "pending" && "Tracking live"}
          </span>
          <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ color: C.muted, fontSize: 10 }}>peak {outcome.mfePct >= 0 ? "+" : ""}{outcome.mfePct}% / dd {outcome.maePct}%</span>
            <span style={{ color: resultClr, fontSize: 13, fontWeight: 800 }}>{outcome.resultPct >= 0 ? "+" : ""}{outcome.resultPct}%</span>
          </span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 8 }}>
        {[
          { l: "Entry", v: entry.entry },
          { l: "Target", v: entry.target },
          { l: "Stop", v: entry.stopLoss },
          { l: "R:R", v: entry.rr ? `1:${entry.rr}` : "—" },
        ].map(({ l, v }) => (
          <div key={l} style={{ background: C.dim, borderRadius: 6, padding: "6px 8px" }}>
            <div style={{ color: C.muted, fontSize: 9, textTransform: "uppercase" }}>{l}</div>
            <div style={{ color: C.text, fontSize: 11, fontWeight: 700 }}>{v != null ? (l === "R:R" ? v : `₹${fmt(v, 0)}`) : "—"}</div>
          </div>
        ))}
      </div>

      <div style={{ color: C.muted, fontSize: 11, marginBottom: 8 }}>
        Score · Buy {entry.scores.buyW} vs Sell {entry.scores.sellW} (margin {entry.scores.margin >= 0 ? "+" : ""}{entry.scores.margin})
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ width: "100%", padding: 8, borderRadius: 8, background: C.dim, border: `1px solid ${C.border}`, color: C.muted, fontSize: 11, fontWeight: 700, cursor: "pointer" }}
      >
        {open ? "Hide details" : "Show signal metadata"}
      </button>

      {open && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.dim}` }}>
          {entry.technical && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ color: C.muted, fontSize: 10, fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>Technical snapshot</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 11 }}>
                <div style={{ color: C.text }}>RSI: {entry.technical.rsi?.toFixed?.(1) ?? entry.technical.rsi ?? "—"}</div>
                <div style={{ color: C.text }}>MACD hist: {entry.technical.macdHist?.toFixed?.(2) ?? entry.technical.macdHist ?? "—"}</div>
                <div style={{ color: C.text }}>EMA20: ₹{fmt(entry.technical.ema20, 0)}</div>
                <div style={{ color: C.text }}>EMA50: ₹{fmt(entry.technical.ema50, 0)}</div>
                <div style={{ color: C.text }}>Support: ₹{fmt(entry.technical.support, 0)}</div>
                <div style={{ color: C.text }}>Resistance: ₹{fmt(entry.technical.resistance, 0)}</div>
                <div style={{ color: C.text, gridColumn: "1 / -1" }}>Liquidity: {entry.technical.liquidity ?? "—"} ({Math.round((entry.technical.liquidityRatio ?? 1) * 100)}% avg vol)</div>
              </div>
            </div>
          )}
          {entry.factors?.length > 0 && (
            <div>
              <div style={{ color: C.muted, fontSize: 10, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Signal factors</div>
              {entry.factors.map((f, i) => <SignalFactorRow key={i} factor={f} C={C} />)}
            </div>
          )}
          {entry.marketStatus && (
            <div style={{ color: C.muted, fontSize: 11, marginTop: 8 }}>
              Market: {entry.marketStatus.label} · {entry.marketStatus.detail}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FinalCallHeader({ label, confidence, action, C }) {
  const clr = action === "BUY" ? C.green : action === "SELL" ? C.red : C.yellow;
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
      <div style={{
        background: clr,
        color: action === "HOLD" || action === "WAIT" ? C.text : "#000",
        fontWeight: 900,
        fontSize: 18,
        padding: "10px 18px",
        borderRadius: 10,
        letterSpacing: 0.5,
        boxShadow: `0 0 20px ${clr}44`,
      }}>
        {label}
      </div>
      <div style={{
        textAlign: "center",
        background: `${clr}18`,
        border: `2px solid ${clr}`,
        borderRadius: 12,
        padding: "8px 14px",
        minWidth: 88,
      }}>
        <div style={{ color: C.muted, fontSize: 9, fontWeight: 700, textTransform: "uppercase", marginBottom: 2 }}>Confidence</div>
        <div style={{ color: clr, fontWeight: 900, fontSize: 22, lineHeight: 1 }}>{confidence}%</div>
      </div>
    </div>
  );
}

function TradeLevelsRow({ entry, target, stopLoss, rr, action, decimals, C }) {
  if (action === "HOLD" || action === "WAIT" || !target) {
    return (
      <p style={{ color: C.muted, fontSize: 11, margin: "0 0 12px", fontStyle: "italic" }}>
        No entry levels — wait for a clear BUY or SELL signal.
      </p>
    );
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginBottom: 12 }}>
      {[
        { l: "Entry", v: fmt(entry, decimals), c: C.blue },
        { l: "Target", v: fmt(target, decimals), c: C.green },
        { l: "Stop Loss", v: fmt(stopLoss, decimals), c: C.red },
        { l: "R:R", v: rr ? `1:${rr}` : "—", c: C.yellow },
      ].map((x) => (
        <div key={x.l} style={{ background: C.dim, borderRadius: 8, padding: "8px 4px", textAlign: "center" }}>
          <div style={{ color: C.muted, fontSize: 9, marginBottom: 3, textTransform: "uppercase" }}>{x.l}</div>
          <div style={{ color: x.c, fontWeight: 800, fontSize: 11 }}>{x.v}</div>
        </div>
      ))}
    </div>
  );
}

function AskEASection({ eaKey, instrument, mode, finalCall, priceData, eaState, onAskEA, C }) {
  const state = eaState?.[eaKey] || {};
  if (!finalCall || finalCall.action === "WAIT") return null;

  const cp = priceData?.cur ?? 0;
  const chgPct = priceData?.prev ? +(((cp - priceData.prev) / priceData.prev) * 100).toFixed(2) : 0;
  const isHighConfBuy = finalCall.action === "BUY" && (finalCall.confidence ?? 0) >= 55;

  return (
    <div style={{ marginBottom: 10 }}>
      <button
        type="button"
        onClick={() => onAskEA(eaKey, { instrument, mode, price: { cur: cp, chgPct }, finalCall })}
        disabled={state.loading}
        style={{
          width: "100%",
          padding: "10px 14px",
          borderRadius: 8,
          background: state.loading ? C.dim : isHighConfBuy ? `${C.blue}28` : `${C.blue}14`,
          border: `1px solid ${C.blue}77`,
          color: C.blue,
          fontSize: 12,
          fontWeight: 800,
          cursor: state.loading ? "wait" : "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
        }}
      >
        <MessageCircle size={14} />
        {state.loading ? "Asking EA…" : "Ask EA — get AI second opinion"}
      </button>
      {(state.text || state.error) && (
        <div style={{
          marginTop: 8,
          background: `${C.blue}10`,
          border: `1px solid ${state.error ? C.red : C.blue}44`,
          borderRadius: 10,
          padding: 12,
        }}>
          <div style={{ color: C.blue, fontSize: 10, fontWeight: 800, marginBottom: 6, textTransform: "uppercase" }}>EA opinion</div>
          <p style={{ color: state.error ? C.red : C.text, fontSize: 12, lineHeight: 1.55, margin: 0, whiteSpace: "pre-wrap" }}>
            {state.error ? `⚠️ ${state.error}` : state.text}
          </p>
        </div>
      )}
    </div>
  );
}

function SwingStatusCard({ name, call, priceData, decimals = 2, onOpenDetail, C, S }) {
  const action = call?.action || "WAIT";
  const clr = action === "BUY" ? C.green : action === "SELL" ? C.red : C.yellow;
  const cp = priceData?.cur ?? 0;
  const chg = priceData?.prev ? +(cp - priceData.prev).toFixed(2) : 0;
  const pct = priceData?.prev ? +((chg / priceData.prev) * 100).toFixed(2) : 0;
  const reason = call?.factors?.[0]?.reason || null;
  return (
    <div onClick={onOpenDetail} style={{ ...S.card, borderColor: `${clr}44`, padding: 12, marginBottom: 10, cursor: onOpenDetail ? "pointer" : "default" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>{name}</span>
            <span style={{ fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4, background: `${C.blue}22`, color: C.blue }}>Swing</span>
          </div>
          <div style={{ color: C.muted, fontSize: 11, marginTop: 3 }}>
            ₹{fmt(cp, decimals)} · today {pct >= 0 ? "+" : ""}{pct}%
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <span style={{ background: clr, color: action === "HOLD" || action === "WAIT" ? C.text : "#000", fontSize: 11, fontWeight: 800, padding: "3px 10px", borderRadius: 5 }}>
            {call?.label || "Analyzing…"}
          </span>
          {call?.confidence != null && <div style={{ color: clr, fontWeight: 900, fontSize: 13, marginTop: 4 }}>{call.confidence}%</div>}
        </div>
      </div>
      {reason && <p style={{ color: C.muted, fontSize: 11, margin: "8px 0 0", lineHeight: 1.4 }}>{reason}</p>}
    </div>
  );
}

function PortfolioSuggestionCard({ item, onSelect, C, S }) {
  const clr = item.action === "BUY" ? C.green : item.action === "SELL" ? C.red : C.yellow;
  const decimals = item.name === "NIFTY" ? 0 : 2;
  return (
    <div onClick={onSelect} style={{ ...S.card, borderColor: `${clr}44`, padding: 12, marginBottom: 10, cursor: onSelect ? "pointer" : "default" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>{item.name}</span>
            <span style={{ fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4, background: `${C.blue}28`, color: C.blue }}>{item.mode}</span>
          </div>
          {item.price != null && (
            <div style={{ color: C.muted, fontSize: 11, marginTop: 3 }}>
              ₹{fmt(item.price, decimals)} · today {item.dayPct >= 0 ? "+" : ""}{item.dayPct}%
            </div>
          )}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <span style={{ background: clr, color: item.action === "HOLD" || item.action === "WAIT" ? C.text : "#000", fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 4 }}>
            {item.label}
          </span>
          <div style={{ color: clr, fontWeight: 900, fontSize: 13, marginTop: 4 }}>{item.confidence}%</div>
        </div>
      </div>
      <p style={{ color: C.text, fontSize: 12, lineHeight: 1.45, margin: 0 }}>{item.reason}</p>
      {item.newsHeadline && (
        <p style={{ color: C.muted, fontSize: 11, margin: "8px 0 0", lineHeight: 1.4 }}>
          📰 {item.newsHeadline}
        </p>
      )}
      {onSelect && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2, color: C.blue, fontSize: 11, fontWeight: 700, marginTop: 8 }}>
          Chart, technicals & fundamentals <ChevronRight size={13} />
        </div>
      )}
    </div>
  );
}

function horizonVerdict(shortCall, longCall) {
  const s = shortCall?.action;
  const l = longCall?.action;
  if (!s && !l) return null;
  if (s === "BUY" && l === "BUY") return { text: "Attractive on both horizons — good for a short-term trade and a long-term hold.", tone: "green" };
  if (l === "BUY" && s !== "BUY") return { text: "Better as a long-term investment; short-term isn't a clean entry yet.", tone: "blue" };
  if (s === "BUY" && l !== "BUY") return { text: "Short-term trade setup, but long-term conviction is weak — keep a tight stop.", tone: "yellow" };
  if (l === "SELL" && s === "SELL") return { text: "Weak on both horizons — consider trimming or staying out.", tone: "red" };
  if (l === "SELL") return { text: "Long-term trend is weak — be cautious about holding for the long run.", tone: "red" };
  if (s === "SELL") return { text: "Short-term momentum is negative — a dip/pullback may be underway.", tone: "yellow" };
  return { text: "Mixed signals — no strong edge right now. Wait for confirmation.", tone: "muted" };
}

function HorizonCallCard({ title, subtitle, call, priceData, eaKey, symbol, mode, decimals = 2, eaState, onAskEA, C }) {
  if (!call) {
    return (
      <div style={{ background: C.dim, borderRadius: 12, padding: 14, marginBottom: 10, textAlign: "center", color: C.muted, fontSize: 12 }}>
        {title} — loading…
      </div>
    );
  }
  const clr = call.action === "BUY" ? C.green : call.action === "SELL" ? C.red : C.yellow;
  return (
    <div style={{ background: C.card, border: `1px solid ${clr}44`, borderRadius: 12, padding: 14, marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
        <div>
          <div style={{ color: C.text, fontWeight: 800, fontSize: 14 }}>{title}</div>
          <div style={{ color: C.muted, fontSize: 10 }}>{subtitle}</div>
        </div>
        {call.fundamentalScore != null && (
          <span style={{ fontSize: 9, fontWeight: 800, padding: "3px 8px", borderRadius: 5, background: call.fundamentalScore >= 1 ? `${C.green}22` : call.fundamentalScore <= -1 ? `${C.red}22` : `${C.muted}22`, color: call.fundamentalScore >= 1 ? C.green : call.fundamentalScore <= -1 ? C.red : C.muted }}>
            Fundamentals {call.fundamentalScore > 0 ? "+" : ""}{call.fundamentalScore}
          </span>
        )}
      </div>
      <FinalCallHeader label={call.label} confidence={call.confidence} action={call.action} C={C} />
      <TradeLevelsRow entry={call.entry} target={call.target} stopLoss={call.stopLoss} rr={call.rr} action={call.action} decimals={decimals} C={C} />
      {call.factors?.length > 0 && (
        <div style={{ borderTop: `1px solid ${C.dim}`, paddingTop: 8, marginBottom: 4 }}>
          {call.factors.slice(0, 4).map((f, i) => <SignalFactorRow key={i} factor={f} C={C} />)}
        </div>
      )}
      <AskEASection
        eaKey={eaKey}
        instrument={symbol}
        mode={mode}
        finalCall={call}
        priceData={priceData}
        eaState={eaState}
        onAskEA={onAskEA}
        C={C}
      />
    </div>
  );
}

function StockDetailModal({ stock, news = [], sett, eaState, onAskEA, onClose, C, S }) {
  const sym = (stock?.name || "").toUpperCase();
  const dataSym = SYMBOL_MAP[sym] || sym;
  const isNifty = sym === "NIFTY";
  const dec = sym === "NIFTY" ? 0 : 2;
  const [quote, setQuote] = useState(null);
  const [fund, setFund] = useState(null);
  const [candlesByTf, setCandlesByTf] = useState({});
  const [chartTf, setChartTf] = useState(sym === "NIFTY" ? "5m" : "1d");
  const [loading, setLoading] = useState(true);
  const [showSummary, setShowSummary] = useState(false);

  const HORIZONS = [
    { tf: "5m", label: "Intraday" },
    { tf: "1h", label: "Swing" },
    { tf: "1d", label: "Long term" },
  ];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setQuote(null);
    setFund(null);
    setCandlesByTf({});
    (async () => {
      const tfA = isNifty ? "5m" : "1h";
      const [q, f, cA, d1] = await Promise.all([
        fetchStockQuote(dataSym),
        fetchStockFundamentals(dataSym),
        fetchStockCandles(dataSym, tfA),
        fetchStockCandles(dataSym, "1d"),
      ]);
      if (cancelled) return;
      setQuote(q);
      setFund(f);
      setCandlesByTf({ [tfA]: cA || [], "1d": d1 || [] });
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [dataSym, isNifty]);

  useEffect(() => {
    if (candlesByTf[chartTf]) return;
    let cancelled = false;
    (async () => {
      const c = await fetchStockCandles(dataSym, chartTf);
      if (!cancelled) setCandlesByTf((p) => ({ ...p, [chartTf]: c || [] }));
    })();
    return () => { cancelled = true; };
  }, [chartTf, dataSym, candlesByTf]);

  const analysisByTf = useMemo(() => {
    const out = {};
    for (const [k, c] of Object.entries(candlesByTf)) out[k] = c?.length ? analyzeFromCandles(c) : null;
    return out;
  }, [candlesByTf]);

  const price = quote?.current ?? stock?.cur ?? fund?.keyStats?.price ?? 0;
  const prev = quote?.previousClose ?? fund?.keyStats?.previousClose ?? stock?.buy ?? price;
  const chg = +(price - prev).toFixed(2);
  const chgPct = prev ? +((chg / prev) * 100).toFixed(2) : 0;
  const isUp = chg >= 0;
  const priceData = { cur: price, prev };

  const stockNews = useMemo(
    () => news.filter((n) =>
      (n.stocks || []).some((s) => String(s).toUpperCase() === sym)
      || (n.headline || "").toUpperCase().includes(sym)
    ).slice(0, 6),
    [news, sym]
  );

  // NIFTY = scalping only, and only surface BUY/SELL when a ≥100-point move looks likely.
  const scalpCall = useMemo(() => {
    if (!isNifty) return null;
    const a = analysisByTf["5m"];
    if (!a || !price) return null;
    const idx = generateIndexSignals(a, price, "NIFTY", sett);
    const call = buildUnifiedSuggestion({ analysis: a, price, chgPct, indexSignals: idx, settings: sett, mode: "scalp", instrument: "NIFTY" });
    const moveDist = call.target != null ? Math.abs(call.target - call.entry) : 0;
    if ((call.action === "BUY" || call.action === "SELL") && moveDist < NIFTY_MIN_PASS_POINTS) {
      return { ...call, action: "HOLD", label: "No scalp trade", target: null, stopLoss: null, rr: null, gatedReason: `Projected move ~${Math.round(moveDist)} pts — under ${NIFTY_MIN_PASS_POINTS} pts, not worth scalping.` };
    }
    return call;
  }, [isNifty, analysisByTf, price, chgPct, sett]);

  const shortCall = useMemo(() => {
    if (isNifty) return null;
    const a = analysisByTf["1h"];
    if (!a || !price) return null;
    return getPortfolioSuggestion({ stock, analysis: a, newsItems: stockNews, quote: { current: price, changePercent: chgPct }, fundamentals: fund?.fundamentals, settings: sett, mode: "swing" });
  }, [isNifty, analysisByTf, price, chgPct, stock, stockNews, fund, sett]);

  const longCall = useMemo(() => {
    if (isNifty) return null;
    const a = analysisByTf["1d"];
    if (!a || !price) return null;
    return getPortfolioSuggestion({ stock, analysis: a, newsItems: stockNews, quote: { current: price, changePercent: chgPct }, fundamentals: fund?.fundamentals, settings: sett, mode: "longterm" });
  }, [isNifty, analysisByTf, price, chgPct, stock, stockNews, fund, sett]);

  const verdict = isNifty ? null : horizonVerdict(shortCall, longCall);
  const verdictClr = verdict ? { green: C.green, blue: C.blue, yellow: C.yellow, red: C.red, muted: C.muted }[verdict.tone] : C.muted;

  const chartCandles = candlesByTf[chartTf] || [];
  const candleSlice = chartCandles.slice(-45);
  const chartAnalysis = analysisByTf[chartTf];
  const overlays = chartAnalysis ? {
    ema20: chartAnalysis.ema20,
    ema50: chartAnalysis.ema50,
    support: chartAnalysis.sr?.support,
    resistance: chartAnalysis.sr?.resistance,
    price,
    priceUp: isUp,
  } : null;

  const ks = fund?.keyStats || {};
  const f = fund?.fundamentals || null;
  const range52 = (ks.fiftyTwoWeekHigh && ks.fiftyTwoWeekLow && ks.fiftyTwoWeekHigh > ks.fiftyTwoWeekLow)
    ? Math.min(100, Math.max(0, ((price - ks.fiftyTwoWeekLow) / (ks.fiftyTwoWeekHigh - ks.fiftyTwoWeekLow)) * 100))
    : null;

  const compact = (n) => {
    if (n == null || isNaN(n)) return "—";
    const a = Math.abs(n);
    if (a >= 1e7) return (n / 1e7).toFixed(2) + " Cr";
    if (a >= 1e5) return (n / 1e5).toFixed(2) + " L";
    if (a >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  };
  const crore = (n) => (n == null ? "—" : `₹${(n / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr`);

  const statBox = (label, value, valueColor) => (
    <div style={{ background: C.dim, borderRadius: 8, padding: "8px 10px" }}>
      <div style={{ color: C.muted, fontSize: 9, textTransform: "uppercase", marginBottom: 2 }}>{label}</div>
      <div style={{ color: valueColor || C.text, fontSize: 12, fontWeight: 700 }}>{value}</div>
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 210, display: "flex", flexDirection: "column", background: C.bg, backgroundImage: C.bgGrad }}>
      <div style={{ ...glassStyle(C), borderTop: "none", borderLeft: "none", borderRight: "none", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, position: "sticky", top: 0, zIndex: 5 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: C.text, fontWeight: 900, fontSize: 18 }}>{sym}</span>
            <span style={{ color: isUp ? C.green : C.red, fontSize: 12, fontWeight: 700 }}>
              {isUp ? <ArrowUp size={11} style={{ verticalAlign: "middle" }} /> : <ArrowDown size={11} style={{ verticalAlign: "middle" }} />}
              {" "}₹{fmt(price, dec)} ({chgPct >= 0 ? "+" : ""}{chgPct}%)
            </span>
          </div>
          <div style={{ color: C.muted, fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {fund?.name || "Loading…"}{fund?.exchange ? ` · ${fund.exchange}` : ""}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close" style={{ background: C.dim, border: "none", color: C.muted, cursor: "pointer", borderRadius: 8, padding: 6, flexShrink: 0 }}><X size={18} /></button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px max(24px, env(safe-area-inset-bottom))" }}>
        {verdict && (
          <div style={{ ...S.card, borderColor: `${verdictClr}55`, marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <Lightbulb size={14} color={verdictClr} />
              <span style={{ color: C.text, fontWeight: 800, fontSize: 13 }}>Verdict</span>
            </div>
            <p style={{ color: C.text, fontSize: 13, lineHeight: 1.5, margin: 0 }}>{verdict.text}</p>
            <p style={{ color: C.muted, fontSize: 10, margin: "8px 0 0" }}>Based on live chart indicators + recent news. Not investment advice.</p>
          </div>
        )}

        {isNifty ? (
          <>
            <HorizonCallCard
              title="Scalping"
              subtitle="5-min chart · intraday · targets a ≥100-pt move"
              call={scalpCall}
              priceData={priceData}
              eaKey={`DETAIL_${sym}_scalp`}
              symbol={sym}
              mode="scalp"
              decimals={dec}
              eaState={eaState}
              onAskEA={onAskEA}
              C={C}
            />
            {scalpCall?.gatedReason && (
              <div style={{ ...S.card, marginTop: -2, marginBottom: 10, color: C.muted, fontSize: 12, lineHeight: 1.5 }}>
                {scalpCall.gatedReason}
              </div>
            )}
          </>
        ) : (
          <>
            <HorizonCallCard
              title="Short-term (swing)"
              subtitle="Hourly chart · days to a few weeks"
              call={shortCall}
              priceData={priceData}
              eaKey={`DETAIL_${sym}_short`}
              symbol={sym}
              mode="swing"
              decimals={dec}
              eaState={eaState}
              onAskEA={onAskEA}
              C={C}
            />

            <HorizonCallCard
              title="Long-term (positional)"
              subtitle="Daily chart · weeks to months · fundamentals-weighted"
              call={longCall}
              priceData={priceData}
              eaKey={`DETAIL_${sym}_long`}
              symbol={sym}
              mode="longterm"
              decimals={dec}
              eaState={eaState}
              onAskEA={onAskEA}
              C={C}
            />
          </>
        )}

        <div style={{ ...S.card }}>
          <div style={{ display: "flex", gap: 4, marginBottom: 10, flexWrap: "wrap" }}>
            {HORIZONS.map((h) => (
              <button key={h.tf} type="button" onClick={() => setChartTf(h.tf)} style={{ padding: "6px 12px", borderRadius: 8, background: chartTf === h.tf ? C.green : C.dim, color: chartTf === h.tf ? "#000" : C.muted, border: `1px solid ${C.border}`, fontSize: 11, cursor: "pointer", fontWeight: 700 }}>
                {h.label}
              </button>
            ))}
          </div>
          {candleSlice.length > 0 ? (
            <>
              <CandleChart candles={candleSlice} height={220} C={C} overlays={overlays} />
              <ChartLegend overlays={overlays} decimals={dec} C={C} />
            </>
          ) : (
            <div style={{ height: 180, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 12 }}>
              {loading ? "Loading chart…" : "Chart data unavailable"}
            </div>
          )}
        </div>

        <div style={{ ...S.card }}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Key stats</div>
          {range52 != null && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.muted, marginBottom: 4 }}>
                <span>52W low ₹{fmt(ks.fiftyTwoWeekLow, dec)}</span>
                <span>52W high ₹{fmt(ks.fiftyTwoWeekHigh, dec)}</span>
              </div>
              <div style={{ position: "relative", height: 6, borderRadius: 3, background: C.dim }}>
                <div style={{ position: "absolute", top: -3, left: `calc(${range52}% - 6px)`, width: 12, height: 12, borderRadius: "50%", background: C.blue, border: `2px solid ${C.bg}` }} />
              </div>
              <div style={{ textAlign: "center", color: C.muted, fontSize: 10, marginTop: 4 }}>Currently {range52.toFixed(0)}% of 52-week range</div>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
            {statBox("Day range", ks.dayLow && ks.dayHigh ? `₹${fmt(ks.dayLow, dec)}–${fmt(ks.dayHigh, dec)}` : "—")}
            {statBox("Volume", compact(ks.volume))}
            {statBox("Prev close", ks.previousClose != null ? `₹${fmt(ks.previousClose, dec)}` : "—")}
            {statBox("50-day avg", ks.fiftyDayAverage != null ? `₹${fmt(ks.fiftyDayAverage, dec)}` : "—", ks.fiftyDayAverage && price >= ks.fiftyDayAverage ? C.green : C.red)}
            {statBox("200-day avg", ks.twoHundredDayAverage != null ? `₹${fmt(ks.twoHundredDayAverage, dec)}` : "—", ks.twoHundredDayAverage && price >= ks.twoHundredDayAverage ? C.green : C.red)}
            {statBox("Market cap", f?.marketCap ? crore(f.marketCap) : "—")}
          </div>
        </div>

        <div style={{ ...S.card }}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Fundamentals</div>
          {f ? (
            <>
              {(f.sector || f.industry) && (
                <div style={{ color: C.muted, fontSize: 11, marginBottom: 10 }}>
                  {[f.sector, f.industry].filter(Boolean).join(" · ")}
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                {statBox("P/E (TTM)", f.trailingPE != null ? f.trailingPE.toFixed(1) : "—")}
                {statBox("Fwd P/E", f.forwardPE != null ? f.forwardPE.toFixed(1) : "—")}
                {statBox("EPS (TTM)", f.trailingEps != null ? `₹${fmt(f.trailingEps)}` : "—")}
                {statBox("P/B", f.priceToBook != null ? f.priceToBook.toFixed(2) : "—")}
                {statBox("Div yield", f.dividendYield != null ? `${f.dividendYield}%` : "—")}
                {statBox("Beta", f.beta != null ? f.beta.toFixed(2) : "—")}
                {statBox("ROE", f.returnOnEquity != null ? `${f.returnOnEquity}%` : "—", f.returnOnEquity >= 15 ? C.green : undefined)}
                {statBox("Profit margin", f.profitMargins != null ? `${f.profitMargins}%` : "—", f.profitMargins >= 0 ? C.green : C.red)}
                {statBox("Rev growth", f.revenueGrowth != null ? `${f.revenueGrowth}%` : "—", f.revenueGrowth >= 0 ? C.green : C.red)}
                {statBox("Debt/Equity", f.debtToEquity != null ? f.debtToEquity.toFixed(0) : "—")}
                {statBox("PEG", f.pegRatio != null ? f.pegRatio.toFixed(2) : "—")}
                {statBox("Analysts", f.numberOfAnalystOpinions != null ? String(f.numberOfAnalystOpinions) : "—")}
              </div>

              {(f.targetMeanPrice != null || f.recommendationKey) && (
                <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: C.dim }}>
                  {f.recommendationKey && (
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: f.targetMeanPrice != null ? 6 : 0 }}>
                      <span style={{ color: C.muted, fontSize: 11 }}>Analyst rating</span>
                      <span style={{ color: /buy/.test(f.recommendationKey) ? C.green : /sell|underperform/.test(f.recommendationKey) ? C.red : C.yellow, fontSize: 12, fontWeight: 800, textTransform: "uppercase" }}>
                        {f.recommendationKey.replace(/_/g, " ")}
                      </span>
                    </div>
                  )}
                  {f.targetMeanPrice != null && (
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ color: C.muted, fontSize: 11 }}>Avg target</span>
                      <span style={{ color: C.text, fontSize: 12, fontWeight: 700 }}>
                        ₹{fmt(f.targetMeanPrice)}{price ? <span style={{ color: f.targetMeanPrice >= price ? C.green : C.red }}> ({f.targetMeanPrice >= price ? "+" : ""}{(((f.targetMeanPrice - price) / price) * 100).toFixed(1)}%)</span> : null}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {f.summary && (
                <div style={{ marginTop: 12 }}>
                  <p style={{ color: C.muted, fontSize: 12, lineHeight: 1.55, margin: 0, maxHeight: showSummary ? "none" : 62, overflow: "hidden" }}>{f.summary}</p>
                  <button type="button" onClick={() => setShowSummary((v) => !v)} style={{ marginTop: 6, background: "none", border: "none", color: C.blue, fontSize: 11, fontWeight: 700, cursor: "pointer", padding: 0 }}>
                    {showSummary ? "Show less" : "Read more"}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.5 }}>
              {loading ? "Loading fundamentals…" : "Detailed fundamentals aren't available for this symbol right now. Key stats above and the technical view still apply."}
            </div>
          )}
        </div>

        <div style={{ ...S.card }}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Technical indicators · {HORIZONS.find((h) => h.tf === chartTf)?.label}</div>
          {chartAnalysis ? (
            <ChartIndicatorPanels analysis={chartAnalysis} instCandles={chartCandles} sett={sett} C={C} S={S} />
          ) : (
            <div style={{ color: C.muted, fontSize: 12 }}>{loading ? "Loading indicators…" : "Indicators unavailable"}</div>
          )}
        </div>

        <div style={{ ...S.card, marginBottom: 0 }}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Latest news</div>
          {stockNews.length ? (
            stockNews.map((n) => (
              <div key={n.id} style={{ padding: "8px 0", borderBottom: `1px solid ${C.dim}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 2 }}>
                  <span style={{ color: n.sentiment === "positive" ? C.green : n.sentiment === "negative" ? C.red : C.yellow, fontSize: 9, fontWeight: 700, textTransform: "uppercase" }}>{n.sentiment || "neutral"}</span>
                  <span style={{ color: C.muted, fontSize: 10 }}>{n.time}</span>
                </div>
                <p style={{ color: C.text, fontSize: 12, lineHeight: 1.45, margin: 0 }}>{n.headline}</p>
              </div>
            ))
          ) : (
            <div style={{ color: C.muted, fontSize: 12 }}>No recent news for {sym}.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function StockPredictionRow({ entry, C, S }) {
  const clr = entry.action === "BUY" ? C.green : C.red;
  const o = entry.outcome;
  const resultClr = o ? (o.resultPct > 0 ? C.green : o.resultPct < 0 ? C.red : C.muted) : C.muted;
  return (
    <div style={{ ...S.card, borderColor: `${clr}33`, padding: 12, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
            <span style={{ color: C.text, fontWeight: 800, fontSize: 14 }}>{entry.symbol}</span>
            <span style={{ background: clr, color: "#000", fontSize: 9, fontWeight: 800, padding: "2px 7px", borderRadius: 4 }}>{entry.action}</span>
            <OutcomeBadge outcome={o} C={C} />
            <span style={{ color: C.text, fontSize: 11, fontWeight: 700 }}>{entry.confidence}%</span>
          </div>
          <div style={{ color: C.muted, fontSize: 10 }}>
            {entry.date} · {entry.firstTime && entry.firstTime !== entry.time ? `${entry.firstTime}–${entry.time}` : entry.time}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 11, marginBottom: o ? 8 : 0 }}>
        <span style={{ color: C.muted }}>Entry <b style={{ color: C.blue }}>₹{fmt(entry.entry)}</b></span>
        <span style={{ color: C.muted }}>Target <b style={{ color: C.green }}>₹{fmt(entry.target)}</b></span>
        <span style={{ color: C.muted }}>SL <b style={{ color: C.red }}>₹{fmt(entry.stopLoss)}</b></span>
      </div>
      {o && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, background: `${resultClr}12`, borderRadius: 8, padding: "6px 10px" }}>
          <span style={{ color: C.muted, fontSize: 11 }}>
            {o.status === "target" ? "Target hit" : o.status === "stop" ? "Stopped out" : o.status === "expired" ? "Expired" : "Tracking"} · peak {o.mfePct >= 0 ? "+" : ""}{o.mfePct}%
          </span>
          <span style={{ color: resultClr, fontSize: 13, fontWeight: 800 }}>{o.resultPct >= 0 ? "+" : ""}{o.resultPct}%</span>
        </div>
      )}
    </div>
  );
}

function PortfolioLogView({ log = [], onClear, C, S }) {
  const stats = summarizeOutcomes(log);
  return (
    <>
      <div style={{ ...S.card, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <ScrollText size={15} color={C.green} />
          <span style={{ color: C.text, fontWeight: 800, fontSize: 14 }}>Stock prediction track record</span>
        </div>
        <p style={{ color: C.muted, fontSize: 11, lineHeight: 1.5, margin: "0 0 10px" }}>
          Every BUY/SELL the app issues for your stocks (≥{PORTFOLIO_LOG_MIN_CONFIDENCE}% confidence) is graded against the real price path — passed = target hit before the stop-loss.
        </p>
        {log.length > 0 && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
              <span style={{ color: C.muted, fontSize: 12 }}>Win rate</span>
              <span style={{ color: stats.winRate == null ? C.muted : stats.winRate >= 50 ? C.green : C.red, fontWeight: 900, fontSize: 18 }}>{stats.winRate == null ? "—" : `${stats.winRate}%`}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
              {[{ l: "Passed", v: stats.passed, c: C.green }, { l: "Failed", v: stats.failed, c: C.red }, { l: "Active", v: stats.active, c: C.yellow }, { l: "Expired", v: stats.expired, c: C.muted }].map((s) => (
                <div key={s.l} style={{ background: C.dim, borderRadius: 8, padding: "8px 4px", textAlign: "center" }}>
                  <div style={{ color: s.c, fontWeight: 900, fontSize: 17 }}>{s.v}</div>
                  <div style={{ color: C.muted, fontSize: 9, textTransform: "uppercase" }}>{s.l}</div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
              <button type="button" onClick={onClear} style={{ padding: "6px 10px", borderRadius: 6, background: `${C.red}18`, border: `1px solid ${C.red}44`, color: C.red, fontSize: 11, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}><Trash2 size={12} /> Clear</button>
            </div>
          </>
        )}
      </div>
      {log.length === 0 ? (
        <div style={{ ...S.card, textAlign: "center", color: C.muted, padding: 20 }}>
          No stock predictions logged yet. When a watchlist stock gets a strong BUY/SELL, it's tracked here automatically.
        </div>
      ) : (
        log.map((e) => <StockPredictionRow key={e.id} entry={e} C={C} S={S} />)
      )}
    </>
  );
}

function PortfolioTab({
  portfolio,
  suggestionItems,
  portfolioFundamentals,
  portfolioSignalLog,
  onSelectStock,
  onAddSymbol,
  onRemoveStock,
  onClearLog,
  csvRef,
  onCsvChange,
  C,
  S,
}) {
  const [view, setView] = useState("watchlist");
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState("suggestion");
  const [suggestOpen, setSuggestOpen] = useState(false);
  const inputRef = useRef(null);

  const heldSymbols = portfolio.map((s) => s.name);
  const q = query.trim().toUpperCase();

  const suggByName = useMemo(() => {
    const m = {};
    for (const it of suggestionItems) m[it.name.toUpperCase()] = it;
    return m;
  }, [suggestionItems]);

  const orderByName = useMemo(() => {
    const m = {};
    suggestionItems.forEach((it, i) => { m[it.name.toUpperCase()] = i; });
    return m;
  }, [suggestionItems]);

  const sectorOf = (s) => portfolioFundamentals?.[s.name.toUpperCase()]?.sector
    || (s.sector && s.sector !== "Other" && s.sector !== "Stock" ? s.sector : "Other");

  const addMatches = q ? filterStockSuggestions(query, heldSymbols) : [];
  const alreadyHeld = q && heldSymbols.some((h) => h.toUpperCase() === q);

  const visible = useMemo(() => {
    let list = portfolio.filter((s) => s.type !== "mf").filter((s) => !q || s.name.toUpperCase().includes(q));
    if (sortMode === "az") {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortMode === "sector") {
      list = [...list].sort((a, b) => {
        const sa = sectorOf(a); const sb = sectorOf(b);
        if (sa !== sb) return sa.localeCompare(sb);
        return a.name.localeCompare(b.name);
      });
    } else {
      list = [...list].sort((a, b) => {
        const ai = orderByName[a.name.toUpperCase()] ?? Infinity;
        const bi = orderByName[b.name.toUpperCase()] ?? Infinity;
        if (ai !== bi) return ai - bi;
        return a.name.localeCompare(b.name);
      });
    }
    return list;
  }, [portfolio, q, sortMode, orderByName, portfolioFundamentals]);

  const mfEntries = portfolio.filter((s) => s.type === "mf");

  const addTyped = () => {
    if (!q || alreadyHeld) return;
    onAddSymbol(q);
    setQuery("");
    setSuggestOpen(false);
  };
  const pick = (sym) => {
    onAddSymbol(sym);
    setQuery("");
    setSuggestOpen(false);
    inputRef.current?.focus();
  };

  const renderRow = (s) => {
    const it = suggByName[s.name.toUpperCase()];
    const action = it?.action;
    const clr = action === "BUY" ? C.green : action === "SELL" ? C.red : C.yellow;
    return (
      <div key={s.id} style={{ ...S.card, borderColor: it ? `${clr}35` : C.border, padding: 12, marginBottom: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
          <div onClick={() => onSelectStock(s)} style={{ minWidth: 0, cursor: "pointer", flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>{s.name}</span>
              <span style={{ fontSize: 9, color: C.muted, background: C.dim, borderRadius: 4, padding: "2px 6px" }}>{sectorOf(s)}</span>
              <ChevronRight size={14} color={C.muted} />
            </div>
            {it ? (
              <div style={{ marginTop: 5, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ background: clr, color: action === "HOLD" || action === "WAIT" ? C.text : "#000", fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 4 }}>{it.label}</span>
                <span style={{ color: clr, fontWeight: 800, fontSize: 12 }}>{it.confidence}%</span>
                <span style={{ color: C.muted, fontSize: 11 }}>· {it.reason}</span>
              </div>
            ) : (
              <div style={{ color: C.muted, fontSize: 11, marginTop: 5 }}>Analyzing… recommendation will appear shortly</div>
            )}
          </div>
          <button type="button" onClick={() => onRemoveStock(s.id)} aria-label={`Remove ${s.name}`} style={{ padding: 6, borderRadius: 6, background: `${C.red}18`, border: "none", cursor: "pointer", flexShrink: 0 }}>
            <Trash2 size={14} color={C.red} />
          </button>
        </div>
      </div>
    );
  };

  const groupedBySector = () => {
    const groups = {};
    for (const s of visible) { const k = sectorOf(s); (groups[k] = groups[k] || []).push(s); }
    return Object.keys(groups).sort().map((sec) => (
      <div key={sec}>
        <div style={{ color: C.muted, fontSize: 10, fontWeight: 800, textTransform: "uppercase", margin: "8px 2px 8px" }}>{sec} · {groups[sec].length}</div>
        {groups[sec].map(renderRow)}
      </div>
    ));
  };

  return (
    <div style={{ padding: "0 14px 90px", position: "relative" }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {[{ id: "watchlist", l: "Watchlist" }, { id: "log", l: "Track record" }].map((o) => (
          <button key={o.id} type="button" onClick={() => setView(o.id)} style={{ flex: 1, padding: "9px 8px", borderRadius: 8, background: view === o.id ? C.green : C.card, color: view === o.id ? "#000" : C.muted, border: `1px solid ${C.border}`, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{o.l}</button>
        ))}
      </div>

      {view === "log" ? (
        <PortfolioLogView log={portfolioSignalLog} onClear={onClearLog} C={C} S={S} />
      ) : (
      <>
      <div style={{ position: "relative", marginBottom: 10 }}>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value.toUpperCase()); setSuggestOpen(true); }}
            onFocus={() => setSuggestOpen(true)}
            onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
            onKeyDown={(e) => { if (e.key === "Enter") addTyped(); }}
            placeholder="Search or add a stock (e.g. RELIANCE)"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            style={{ flex: 1, padding: 11, borderRadius: 10, background: C.dim, border: `1px solid ${C.border}`, color: C.text, fontSize: 16, outline: "none" }}
          />
          <button type="button" onClick={addTyped} disabled={!q || alreadyHeld} style={{ padding: "0 14px", borderRadius: 10, background: !q || alreadyHeld ? C.dim : C.green, color: !q || alreadyHeld ? C.muted : "#000", fontWeight: 800, border: "none", cursor: !q || alreadyHeld ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 4 }}>
            <Plus size={16} /> Add
          </button>
        </div>
        {suggestOpen && q && addMatches.length > 0 && (
          <div style={{ position: "absolute", left: 0, right: 0, top: 50, zIndex: 20, background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, maxHeight: 220, overflowY: "auto", boxShadow: `0 8px 24px ${C.bg}88` }}>
            {addMatches.map((sym) => (
              <button key={sym} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(sym)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", textAlign: "left", padding: "10px 12px", background: "transparent", border: "none", borderBottom: `1px solid ${C.dim}`, color: C.text, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                {sym} <span style={{ color: C.green, fontSize: 11, fontWeight: 700 }}>+ Add</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {[{ id: "suggestion", l: "Suggestion" }, { id: "az", l: "A–Z" }, { id: "sector", l: "Sector" }].map((o) => (
          <button key={o.id} type="button" onClick={() => setSortMode(o.id)} style={{ flex: 1, padding: "8px 6px", borderRadius: 8, background: sortMode === o.id ? C.green : C.card, color: sortMode === o.id ? "#000" : C.muted, border: `1px solid ${C.border}`, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>{o.l}</button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div style={{ ...S.card, textAlign: "center", color: C.muted, padding: 20 }}>
          {portfolio.length === 0
            ? "Your watchlist is empty. Search a stock above and tap Add."
            : "No stocks match your search."}
        </div>
      ) : sortMode === "sector" ? (
        groupedBySector()
      ) : (
        visible.map(renderRow)
      )}

      {mfEntries.length > 0 && (
        <>
          <div style={{ color: C.muted, fontSize: 10, fontWeight: 800, textTransform: "uppercase", margin: "14px 2px 8px" }}>Mutual funds</div>
          {mfEntries.map((s) => (
            <div key={s.id} style={{ ...S.card, borderColor: `${C.blue}33`, padding: 12, marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>{s.name}</span>
              <button type="button" onClick={() => onRemoveStock(s.id)} aria-label={`Remove ${s.name}`} style={{ padding: 6, borderRadius: 6, background: `${C.red}18`, border: "none", cursor: "pointer" }}>
                <Trash2 size={14} color={C.red} />
              </button>
            </div>
          ))}
        </>
      )}

      <input ref={csvRef} type="file" accept=".csv,.txt" style={{ display: "none" }} onChange={onCsvChange} />
      <button type="button" onClick={() => csvRef.current?.click()} style={{ width: "100%", marginTop: 10, padding: 10, borderRadius: 10, background: `${C.blue}12`, border: `1px dashed ${C.blue}44`, color: C.blue, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12 }}>
        <Upload size={13} /> Import stocks from CSV
      </button>
      </>
      )}
    </div>
  );
}

function MoveCard({ move, C, S }) {
  return (
    <div style={{
      ...S.card,
      borderColor: move.direction === "down" ? `${C.red}44` : move.direction === "up" ? `${C.green}44` : `${C.yellow}44`,
    }}>
      <div style={{ color: C.text, fontWeight: 800, fontSize: 14, marginBottom: 8 }}>{move.title}</div>
      <p style={{ color: C.text, fontSize: 13, lineHeight: 1.55, margin: "0 0 10px" }}>{move.summary}</p>
      {move.reasons?.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ color: C.muted, fontSize: 10, textTransform: "uppercase", marginBottom: 6 }}>Key reasons</div>
          {move.reasons.map((r, i) => (
            <div key={i} style={{ color: C.muted, fontSize: 12, padding: "6px 0", borderBottom: i < move.reasons.length - 1 ? `1px solid ${C.dim}` : "none" }}>
              • {r}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState("dark");
  const C = THEMES[theme];
  const S = { card: cardStyle(C) };

  const [hydrated, setHydrated] = useState(false);
  const [instrument, setInstrument] = useState("NIFTY");
  const [niftySignalLog, setNiftySignalLog] = useState([]);
  const [portfolioSignalLog, setPortfolioSignalLog] = useState([]);
  const [serverLogConfigured, setServerLogConfigured] = useState(false);
  const [tab, setTab] = useState("dashboard");
  const [tf, setTf] = useState("5m");
  const [refresh, setRefresh] = useState(5);

  const [prices, setPrices] = useState(initPrices);
  const [candles, setCandles] = useState({});
  const [candlesDaily, setCandlesDaily] = useState({});
  const [isLive, setIsLive] = useState(false);
  const [dataSource, setDataSource] = useState(null);
  const [liveError, setLiveError] = useState(null);
  const [signals, setSignals] = useState([]);
  const prevIndexSigs = useRef([]);

  const [portfolio, setPortfolio] = useState(DEFAULT_PORTFOLIO);

  const [news, setNews] = useState([]);
  const [newsOverview, setNewsOverview] = useState("");
  const [selNews, setSelNews] = useState(null);
  const [newsFilter, setNewsFilter] = useState("All");

  const [portfolioAnalyses, setPortfolioAnalyses] = useState({});
  const [stockQuotes, setStockQuotes] = useState({});
  const [portfolioFundamentals, setPortfolioFundamentals] = useState({});

  const [sett, setSett] = useState({
    riskLimit: 10000, profitPct: 1.5, slPct: 0.8,
    ind: { rsi: true, macd: true, bb: true, ema20: true, ema50: true, vol: true },
  });
  const [alerts, setAlerts] = useState({ sound: true, notification: true });

  const [marketStatus, setMarketStatus] = useState(() => getMarketStatus());
  const [selectedStock, setSelectedStock] = useState(null);

  const [chatOpen, setChatOpen] = useState(false);
  const [msgs, setMsgs] = useState([
    { role: "assistant", content: "👋 Hi! I'm your EA assistant.\n\nTry: \"Add RELIANCE 10 shares at 2850\", \"Remove TCS from portfolio\", \"Switch to GOLD\", or \"What does RSI say for NIFTY?\"" },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatModel, setChatModel] = useState(DEFAULT_GEMINI_MODEL);
  const [chatLoading, setChatLoading] = useState(false);
  const [eaState, setEaState] = useState({});
  const chatEnd = useRef(null);
  const csvRef = useRef(null);
  const portfolioRef = useRef(portfolio);
  const pricesRef = useRef(prices);
  const prevNiftyLogRef = useRef(null);
  const niftyLogRef = useRef([]);
  const portfolioLogRef = useRef([]);
  const serverLogConfiguredRef = useRef(false);
  portfolioRef.current = portfolio;
  pricesRef.current = prices;
  niftyLogRef.current = niftySignalLog;
  portfolioLogRef.current = portfolioSignalLog;
  serverLogConfiguredRef.current = serverLogConfigured;
  const stockNamesKey = portfolio.map((p) => p.name).sort().join(",");

  // Hydrate from localStorage
  useEffect(() => {
    const data = loadPersisted();
    if (data) {
      if (data.theme) setTheme(data.theme);
      if (data.portfolio?.length) setPortfolio(data.portfolio);
      if (data.sett) setSett(data.sett);
      if (data.refresh) setRefresh(data.refresh);
      if (data.alerts) setAlerts(data.alerts);
      if (data.chatModel && GEMINI_CHAT_MODELS.some((m) => m.id === data.chatModel)) setChatModel(data.chatModel);
      if (data.niftySignalLog?.length) {
        setNiftySignalLog(data.niftySignalLog);
        prevNiftyLogRef.current = data.niftySignalLog[0];
      }
      if (data.portfolioSignalLog?.length) setPortfolioSignalLog(data.portfolioSignalLog);
    }
    setHydrated(true);
  }, []);

  const syncNiftyLogFromServer = useCallback(async () => {
    try {
      const res = await fetch("/api/nifty-log", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setServerLogConfigured(Boolean(data.configured));
      if (!data.logs?.length) return;
      setNiftySignalLog((local) => {
        const merged = mergeNiftyLogLists(data.logs, local);
        prevNiftyLogRef.current = merged[0] ?? null;
        return merged;
      });
    } catch {
      /* offline or server not configured */
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    syncNiftyLogFromServer();
    const id = setInterval(syncNiftyLogFromServer, 60_000);
    return () => clearInterval(id);
  }, [hydrated, syncNiftyLogFromServer]);

  // Persist on change
  useEffect(() => {
    if (!hydrated) return;
    savePersisted({ theme, portfolio, sett, refresh, alerts, chatModel, niftySignalLog, portfolioSignalLog });
  }, [hydrated, theme, portfolio, sett, refresh, alerts, chatModel, niftySignalLog, portfolioSignalLog]);

  // Market status ticker
  useEffect(() => {
    const id = setInterval(() => setMarketStatus(getMarketStatus()), 30000);
    return () => clearInterval(id);
  }, []);

  // Live index prices
  useEffect(() => {
    let cancelled = false;
    const refreshLive = async () => {
      const result = await fetchAllMarketData();
      if (cancelled) return;
      if (result.isLive) {
        setPrices((prev) => ({ ...prev, ...result.prices }));
        setIsLive(true);
        setDataSource(result.source);
        setLiveError(result.liveCount < result.total ? `Live: ${result.liveCount}/${result.total}` : null);
      } else {
        setIsLive(false);
        setDataSource(null);
        setLiveError(result.error || "Using simulated prices");
      }
    };
    refreshLive();
    const id = setInterval(refreshLive, refresh * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [refresh]);

  // Simulate prices only when live fails entirely
  useEffect(() => {
    if (isLive) return;
    const id = setInterval(() => {
      setPrices((prev) => {
        const next = { ...prev };
        Object.entries(INSTRUMENTS).forEach(([k, v]) => {
          const d = (Math.random() - 0.48) * v.vol * prev[k].cur;
          const cur = +(prev[k].cur + d).toFixed(2);
          next[k] = { ...prev[k], cur, high: Math.max(prev[k].high, cur), low: Math.min(prev[k].low, cur) };
        });
        return next;
      });
    }, refresh * 1000);
    return () => clearInterval(id);
  }, [refresh, isLive]);

  // Real candles for all instruments on timeframe change
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.all(INSTRUMENT_KEYS.map(async (inst) => {
        const data = await fetchCandles(inst, tf);
        if (cancelled) return;
        if (data?.length) {
          setCandles((prev) => ({ ...prev, [inst]: data }));
        } else {
          const base = pricesRef.current[inst]?.cur ?? INSTRUMENTS[inst].base;
          setCandles((prev) => ({ ...prev, [inst]: genFallbackCandles(base, 65, INSTRUMENTS[inst].vol) }));
        }
      }));
    })();
    return () => { cancelled = true; };
  }, [tf]);

  // Daily candles for Gold/Silver long-term view
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.all(["GOLD", "SILVER"].map(async (inst) => {
        const data = await fetchCandles(inst, "1d");
        if (cancelled) return;
        if (data?.length) {
          setCandlesDaily((prev) => ({ ...prev, [inst]: data }));
        }
      }));
    })();
    return () => { cancelled = true; };
  }, [refresh]);

  // Portfolio live prices
  useEffect(() => {
    let cancelled = false;
    const refreshPortfolio = async () => {
      const current = portfolioRef.current;
      if (!current.length) return;
      const updated = await fetchPortfolioPrices(current);
      if (!cancelled) setPortfolio(updated);
    };
    refreshPortfolio();
    const id = setInterval(refreshPortfolio, refresh * 1000 + 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [refresh, stockNamesKey]);

  // Daily candles + indicators for each portfolio holding (for chart/indicator suggestions)
  const portfolioSymbolsKey = useMemo(
    () => portfolio
      .filter((s) => s.type !== "mf" && !MACRO_SYMBOLS.has(s.name.toUpperCase()))
      .map((s) => s.name.toUpperCase())
      .sort()
      .join(","),
    [portfolio]
  );

  useEffect(() => {
    const syms = portfolioSymbolsKey ? portfolioSymbolsKey.split(",") : [];
    if (!syms.length) { setPortfolioAnalyses({}); return; }
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(syms.map(async (sym) => {
        const c = await fetchStockCandles(sym, "1d");
        return [sym, c?.length ? analyzeFromCandles(c) : null];
      }));
      if (!cancelled) setPortfolioAnalyses(Object.fromEntries(entries.filter(([, a]) => a)));
    })();
    return () => { cancelled = true; };
  }, [portfolioSymbolsKey]);

  const portfolioStockSymbols = useMemo(
    () => portfolio
      .filter((s) => s.type !== "mf" && !MACRO_SYMBOLS.has(s.name.toUpperCase()))
      .map((s) => s.name.toUpperCase()),
    [portfolio]
  );

  useEffect(() => {
    const syms = portfolioStockSymbols;
    if (!syms.length) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(syms.map(async (s) => {
        const q = await fetchStockQuote(s);
        return [s, q];
      }));
      if (!cancelled) {
        setStockQuotes(Object.fromEntries(entries.filter(([, q]) => q)));
      }
    })();
    return () => { cancelled = true; };
  }, [portfolioStockSymbols.join(","), refresh]);

  // Fundamentals per holding — fetched when the holdings set changes (slow-moving, not every refresh).
  // Stores the fundamentals object (P/E, ROE, sector, …) keyed by symbol.
  useEffect(() => {
    const syms = portfolioStockSymbols;
    if (!syms.length) { setPortfolioFundamentals({}); return; }
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(syms.map(async (s) => {
        const f = await fetchStockFundamentals(s);
        return [s, f?.fundamentals || null];
      }));
      if (!cancelled) setPortfolioFundamentals(Object.fromEntries(entries.filter(([, f]) => f)));
    })();
    return () => { cancelled = true; };
  }, [portfolioStockSymbols.join(",")]);

  // News
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const stocks = stockNamesKey ? stockNamesKey.split(",") : [];
      const data = await fetchNews(stocks);
      if (!cancelled) {
        setNews(data.news || []);
        setNewsOverview(data.overview || "");
      }
    };
    load();
    const id = setInterval(load, 120000);
    return () => { cancelled = true; clearInterval(id); };
  }, [stockNamesKey]);

  const analyses = useMemo(() => {
    const out = {};
    for (const k of INSTRUMENT_KEYS) {
      const c = candles[k] || [];
      out[k] = c.length ? analyzeFromCandles(c) : null;
    }
    return out;
  }, [candles]);
  const analysis = analyses[instrument];

  const dailyAnalyses = useMemo(() => {
    const out = {};
    for (const k of ["GOLD", "SILVER"]) {
      const c = candlesDaily[k] || [];
      out[k] = c.length ? analyzeFromCandles(c) : null;
    }
    return out;
  }, [candlesDaily]);

  const signalsByInstrument = useMemo(() => {
    const out = {};
    for (const inst of INSTRUMENT_KEYS) {
      const a = analyses[inst];
      const cp = prices[inst]?.cur;
      out[inst] = a && cp ? generateIndexSignals(a, cp, inst, sett) : [];
    }
    return out;
  }, [analyses, prices, sett]);

  const finalCalls = useMemo(() => {
    const niftyPct = prices.NIFTY?.prev
      ? +(((prices.NIFTY.cur - prices.NIFTY.prev) / prices.NIFTY.prev) * 100).toFixed(2) : 0;
    const goldPct = prices.GOLD?.prev
      ? +(((prices.GOLD.cur - prices.GOLD.prev) / prices.GOLD.prev) * 100).toFixed(2) : 0;
    const silverPct = prices.SILVER?.prev
      ? +(((prices.SILVER.cur - prices.SILVER.prev) / prices.SILVER.prev) * 100).toFixed(2) : 0;

    return {
      NIFTY: buildUnifiedSuggestion({
        analysis: analyses.NIFTY,
        price: prices.NIFTY?.cur,
        chgPct: niftyPct,
        indexSignals: signalsByInstrument.NIFTY,
        settings: sett,
        mode: "scalp",
        instrument: "NIFTY",
      }),
      NIFTY_swing: buildUnifiedSuggestion({
        analysis: analyses.NIFTY,
        price: prices.NIFTY?.cur,
        chgPct: niftyPct,
        indexSignals: signalsByInstrument.NIFTY,
        settings: sett,
        mode: "swing",
        instrument: "NIFTY",
      }),
      GOLD_swing: buildUnifiedSuggestion({
        analysis: analyses.GOLD,
        price: prices.GOLD?.cur,
        chgPct: goldPct,
        indexSignals: signalsByInstrument.GOLD,
        settings: sett,
        mode: "swing",
      }),
      GOLD_long: buildUnifiedSuggestion({
        analysis: dailyAnalyses.GOLD || analyses.GOLD,
        price: prices.GOLD?.cur,
        chgPct: goldPct,
        indexSignals: [],
        settings: sett,
        mode: "longterm",
      }),
      SILVER_swing: buildUnifiedSuggestion({
        analysis: analyses.SILVER,
        price: prices.SILVER?.cur,
        chgPct: silverPct,
        indexSignals: signalsByInstrument.SILVER,
        settings: sett,
        mode: "swing",
      }),
      SILVER_long: buildUnifiedSuggestion({
        analysis: dailyAnalyses.SILVER || analyses.SILVER,
        price: prices.SILVER?.cur,
        chgPct: silverPct,
        indexSignals: [],
        settings: sett,
        mode: "longterm",
      }),
    };
  }, [analyses, dailyAnalyses, prices, signalsByInstrument, sett]);

  useEffect(() => {
    if (!hydrated) return;
    const call = finalCalls.NIFTY;
    if (!isLoggableNiftySignal(call)) return;

    const niftyPct = prices.NIFTY?.prev
      ? +(((prices.NIFTY.cur - prices.NIFTY.prev) / prices.NIFTY.prev) * 100).toFixed(2)
      : 0;
    const entry = buildNiftySignalLogEntry({
      finalCall: call,
      priceData: prices.NIFTY,
      analysis: analyses.NIFTY,
      chgPct: niftyPct,
      indexSignals: signalsByInstrument.NIFTY,
      marketStatus,
    });

    setNiftySignalLog((prev) => {
      const { logs, changed } = applyNiftyLogUpdate(prev, entry);
      if (!changed) return prev;
      prevNiftyLogRef.current = logs[0];
      if (serverLogConfiguredRef.current) {
        fetch("/api/nifty-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entry }),
        }).catch(() => {});
      }
      return logs;
    });
  }, [hydrated, finalCalls.NIFTY, prices.NIFTY, analyses.NIFTY, signalsByInstrument.NIFTY, marketStatus]);

  // Grade logged predictions against the real NIFTY price path (passed/failed/expired).
  // Runs on load and every 60s; works retroactively so signals resolved while the
  // app was closed still get graded when it reopens.
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    const evaluate = async () => {
      const openCount = niftyLogRef.current.filter((e) => !e.outcome || e.outcome.status === "pending").length;
      if (!openCount) return;
      const candles = await fetchCandles("NIFTY", "5m");
      if (cancelled || !candles?.length) return;
      setNiftySignalLog((prev) => {
        const { logs, changed } = applyOutcomeToLogs(prev, candles, Date.now());
        if (!changed) return prev;
        prevNiftyLogRef.current = logs[0];
        if (serverLogConfiguredRef.current) {
          fetch("/api/nifty-log", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ logs }),
          }).catch(() => {});
        }
        return logs;
      });
    };
    evaluate();
    const id = setInterval(evaluate, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [hydrated]);

  const niftyMove = useMemo(() => explainAssetMove(prices.NIFTY, news, "NIFTY"), [prices.NIFTY, news]);
  const goldMove = useMemo(() => explainAssetMove(prices.GOLD, news, "GOLD"), [prices.GOLD, news]);
  const silverMove = useMemo(() => explainAssetMove(prices.SILVER, news, "SILVER"), [prices.SILVER, news]);

  useEffect(() => {
    setSignals([
      ...INSTRUMENT_KEYS.flatMap((inst) => signalsByInstrument[inst] || []),
      ...generatePortfolioSignals(portfolio, sett),
    ]);
  }, [signalsByInstrument, sett, portfolio]);

  useEffect(() => {
    if (!hydrated) return;
    const indexSigs = signals.filter((s) => s.scope === "index");
    const prev = prevIndexSigs.current;
    const isNew = indexSigs.some((s) => !prev.find((p) => p.type === s.type && p.reason === s.reason));
    if (isNew && prev.length > 0) {
      if (alerts.sound) playBeep();
      if (alerts.notification && typeof Notification !== "undefined" && Notification.permission === "granted") {
        const sig = indexSigs[0];
        new Notification(`ScalpAI ${sig.type} — ${instrument}`, { body: sig.reason });
      }
    }
    prevIndexSigs.current = indexSigs;
  }, [signals, hydrated, alerts, instrument]);

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  const P = prices[instrument];
  const cp = P?.cur ?? 0;

  const upsertPortfolioStock = useCallback((name, qty, buy, sector = "Other", type = "stock") => {
    const sym = type === "mf" ? String(name).trim() : String(name).toUpperCase().replace(/\.NS$/, "");
    const q = +qty || 1;
    const price = +buy || 0;
    const sec = type === "mf" ? "Mutual Fund" : sector;
    setPortfolio((p) => {
      const existing = p.find((s) => s.name.toUpperCase() === sym.toUpperCase() && s.type === type);
      if (existing) {
        return p.map((s) => (s.id === existing.id
          ? { ...s, name: sym, qty: q, buy: price || s.buy, cur: type === "mf" ? price || s.cur : price || s.cur, sector: sec, type }
          : s));
      }
      return [...p, { id: Date.now(), name: sym, qty: q, buy: price, cur: price, sector: sec, type }];
    });
  }, []);

  const removePortfolioStock = useCallback((nameOrId) => {
    if (typeof nameOrId === "number") {
      setPortfolio((p) => p.filter((s) => s.id !== nameOrId));
      return;
    }
    const sym = String(nameOrId).toUpperCase().replace(/\.NS$/, "");
    setPortfolio((p) => p.filter((s) => s.name.toUpperCase() !== sym));
  }, []);

  const execCmd = useCallback((json) => {
    try {
      const { action, value } = JSON.parse(json);
      if (action === "changeInstrument" && INSTRUMENTS[value]) setInstrument(value);
      if (action === "changeTimeframe") setTf(value);
      if (action === "changeRefreshRate") setRefresh(+value);
      if (action === "toggleIndicator") setSett((p) => ({ ...p, ind: { ...p.ind, [value]: !p.ind[value] } }));
      if (action === "setRiskLimit") setSett((p) => ({ ...p, riskLimit: +value }));
      if (action === "setTheme") setTheme(value === "light" ? "light" : "dark");
      if (action === "addStock") {
        upsertPortfolioStock(value.name, value.qty, value.price ?? value.buy, value.sector);
      }
      if (action === "updateStock") {
        upsertPortfolioStock(value.name, value.qty, value.price ?? value.buy, value.sector);
      }
      if (action === "removeStock") {
        removePortfolioStock(value.name || value.symbol || value);
      }
      if (action === "switchTab") setTab(value === "watchlist" ? "portfolio" : value);
    } catch (_) {}
  }, [upsertPortfolioStock, removePortfolioStock]);

  const askEA = useCallback(async (eaKey, payload) => {
    setEaState((s) => ({ ...s, [eaKey]: { loading: true, text: "", error: null } }));
    try {
      const res = await fetch("/api/ea", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setEaState((s) => ({ ...s, [eaKey]: { loading: false, text: "", error: data.error || "EA unavailable" } }));
        return;
      }
      setEaState((s) => ({ ...s, [eaKey]: { loading: false, text: data.text, error: null } }));
    } catch {
      setEaState((s) => ({ ...s, [eaKey]: { loading: false, text: "", error: "Connection error" } }));
    }
  }, []);

  const sendMsg = async () => {
    if (!chatInput.trim() || chatLoading) return;
    const text = chatInput.trim();
    setChatInput("");
    setMsgs((p) => [...p, { role: "user", content: text }]);
    setChatLoading(true);
    try {
      const portSummary = portfolio.length
        ? portfolio.map((p) => `${p.name} x${p.qty} @ ₹${p.buy}`).join(", ")
        : "empty";
      const sys = `You are EA, an investing assistant for Indian markets (NSE) inside this app.
Focus on swing and long-term investing decisions, not intraday scalping.
When asked whether to buy/sell/hold a stock, weigh BOTH fundamentals (P/E, P/B, ROE, debt, growth, margins, analyst view) AND technicals (trend, RSI, support/resistance), plus recent news. Be concise and practical; always note it is suggestion-only, not financial advice.
Context — NIFTY ₹${fmt(cp)} | RSI ${analysis?.rsi ?? "—"} | Theme ${theme}
User portfolio: ${portSummary}

When the user asks to add, update, or remove holdings, emit a command (no CSV upload in chat):
<CMD>{"action":"addStock","value":{"name":"RELIANCE","qty":10,"price":2850,"sector":"Energy"}}</CMD>
<CMD>{"action":"updateStock","value":{"name":"RELIANCE","qty":15,"price":2900}}</CMD>
<CMD>{"action":"removeStock","value":{"name":"TCS"}}</CMD>

Other commands via <CMD>{"action":"...","value":"..."}</CMD>:
changeRefreshRate, setTheme, switchTab
Tabs: dashboard|portfolio|news|settings`;
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system: sys, messages: [...msgs.slice(-8), { role: "user", content: text }], model: chatModel }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsgs((p) => [...p, { role: "assistant", content: `⚠️ ${data.error || "AI unavailable"}` }]);
        return;
      }
      const full = data.text ?? "Sorry, try again.";
      for (const match of full.matchAll(/<CMD>(.*?)<\/CMD>/gs)) execCmd(match[1].trim());
      setMsgs((p) => [...p, { role: "assistant", content: full.replace(/<CMD>.*?<\/CMD>/gs, "").trim() }]);
    } catch {
      setMsgs((p) => [...p, { role: "assistant", content: "⚠️ Connection error." }]);
    } finally {
      setChatLoading(false);
    }
  };

  const handleCSV = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const parsed = parsePortfolioCSV(ev.target.result);
      if (parsed.length) setPortfolio(parsed);
      else alert("Could not read CSV. Use columns: symbol/name, qty, price/buy (Groww/Zerodha export).");
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const addWatchStock = useCallback((symbol) => {
    const sym = String(symbol || "").trim().toUpperCase().replace(/\.NS$/, "");
    if (!sym) return;
    upsertPortfolioStock(sym, 1, 0, "Other", "stock");
  }, [upsertPortfolioStock]);

  const requestNotifPerm = () => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }
  };

  const portfolioStocks = portfolio.filter((s) => s.type !== "mf" && !MACRO_SYMBOLS.has(s.name.toUpperCase()));

  const matchesSymbol = (n, sym) => {
    const S = sym.toUpperCase();
    return (n.stocks || []).some((st) => st.toUpperCase() === S)
      || (n.headline || "").toUpperCase().includes(S);
  };
  const portfolioNewsBySymbol = useMemo(() => {
    const map = {};
    for (const s of portfolioStocks) {
      map[s.name.toUpperCase()] = news.filter((n) => matchesSymbol(n, s.name));
    }
    return map;
  }, [portfolioSymbolsKey, news]);

  const portfolioSuggestionItems = useMemo(() => {
    const items = [];
    for (const stock of portfolioStocks) {
      const sym = stock.name.toUpperCase();
      const quote = stockQuotes[sym];
      const priceData = quote
        ? { cur: quote.current ?? stock.cur, prev: quote.previousClose ?? stock.buy }
        : { cur: stock.cur, prev: stock.buy };
      const suggestion = getPortfolioSuggestion({
        stock,
        analysis: portfolioAnalyses[sym],
        newsItems: portfolioNewsBySymbol[sym] || [],
        quote,
        fundamentals: portfolioFundamentals[sym],
        settings: sett,
        mode: "longterm",
      });
      pushSuggestionItem(items, {
        id: `hold-${sym}`,
        name: sym,
        mode: "Swing + long",
        call: suggestion,
        priceData,
        newsHeadline: latestNewsHeadline(sym, news),
      });
    }
    return sortPortfolioSuggestions(items);
  }, [
    sett,
    news,
    portfolioStocks,
    portfolioAnalyses,
    portfolioNewsBySymbol,
    stockQuotes,
    portfolioFundamentals,
  ]);

  // Log actionable portfolio suggestions (BUY/SELL) so we can track their outcomes.
  useEffect(() => {
    if (!hydrated) return;
    setPortfolioSignalLog((prev) => {
      let logs = prev;
      let changed = false;
      for (const it of portfolioSuggestionItems) {
        if ((it.action === "BUY" || it.action === "SELL")
          && it.confidence >= PORTFOLIO_LOG_MIN_CONFIDENCE
          && it.entry != null && it.target != null && it.stopLoss != null) {
          const entry = buildPortfolioSignalLogEntry({
            symbol: it.name,
            action: it.action,
            label: it.label,
            confidence: it.confidence,
            price: it.price,
            entry: it.entry,
            target: it.target,
            stopLoss: it.stopLoss,
            rr: it.rr,
            reason: it.reason,
          });
          const res = applyPortfolioLogUpdate(logs, entry);
          if (res.changed) { logs = res.logs; changed = true; }
        }
      }
      return changed ? logs : prev;
    });
  }, [hydrated, portfolioSuggestionItems]);

  // Grade logged stock predictions against each stock's daily price path.
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    const grade = async () => {
      const open = portfolioLogRef.current.filter((e) => !e.outcome || e.outcome.status === "pending");
      if (!open.length) return;
      const symbols = [...new Set(open.map((e) => e.symbol))];
      const candlesBySym = {};
      await Promise.all(symbols.map(async (s) => { candlesBySym[s] = (await fetchStockCandles(s, "1d")) || []; }));
      if (cancelled) return;
      const now = Date.now();
      setPortfolioSignalLog((prev) => {
        let changed = false;
        const next = prev.map((e) => {
          if (e.outcome && e.outcome.status !== "pending") return e;
          const candles = candlesBySym[e.symbol];
          if (!candles?.length) return e;
          const outcome = evaluateSignalOutcome(e, candles, now, { windowMs: PORTFOLIO_EVAL_WINDOW_MS });
          if (!outcome) return e;
          const p = e.outcome;
          if (!p || p.status !== outcome.status || p.resultPct !== outcome.resultPct || p.mfePct !== outcome.mfePct || p.maePct !== outcome.maePct) {
            changed = true;
            return { ...e, outcome };
          }
          return e;
        });
        return changed ? next : prev;
      });
    };
    grade();
    const id = setInterval(grade, 90_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [hydrated]);

  const clearPortfolioLog = useCallback(() => {
    if (typeof window !== "undefined" && !window.confirm("Clear all stock prediction history?")) return;
    setPortfolioSignalLog([]);
  }, []);

  const filteredNews = newsFilter === "All" ? news : news.filter((n) => n.cat === newsFilter);

  // ── TAB COMPONENTS ──
  const Dashboard = () => (
    <div style={{ padding: "0 14px 90px" }}>
      <div style={{ color: C.muted, fontSize: 11, fontWeight: 800, textTransform: "uppercase", margin: "2px 2px 8px" }}>Swing outlook</div>
      <SwingStatusCard
        name="NIFTY"
        call={finalCalls.NIFTY_swing}
        priceData={prices.NIFTY}
        decimals={0}
        onOpenDetail={() => setSelectedStock({ name: "NIFTY", type: "index" })}
        C={C}
        S={S}
      />
      <SwingStatusCard
        name="GOLD"
        call={finalCalls.GOLD_swing}
        priceData={prices.GOLD}
        decimals={2}
        onOpenDetail={() => setSelectedStock({ name: "GOLD", type: "index" })}
        C={C}
        S={S}
      />
      <SwingStatusCard
        name="SILVER"
        call={finalCalls.SILVER_swing}
        priceData={prices.SILVER}
        decimals={2}
        onOpenDetail={() => setSelectedStock({ name: "SILVER", type: "index" })}
        C={C}
        S={S}
      />

      <div style={{ color: C.muted, fontSize: 11, fontWeight: 800, textTransform: "uppercase", margin: "16px 2px 8px" }}>Your stocks · strongest first</div>
      {portfolioSuggestionItems.length === 0 ? (
        <div style={{ ...S.card, textAlign: "center", color: C.muted, padding: 18 }}>
          Add stocks in the Portfolio tab to see buy/sell suggestions here.
        </div>
      ) : (
        portfolioSuggestionItems.map((item) => (
          <PortfolioSuggestionCard
            key={item.id}
            item={item}
            onSelect={() => {
              const held = portfolio.find((p) => p.name.toUpperCase() === item.name.toUpperCase() && p.type !== "mf");
              setSelectedStock(held || { name: item.name, type: "stock" });
            }}
            C={C}
            S={S}
          />
        ))
      )}
    </div>
  );

  const NewsTab = () => (
    <div style={{ padding: "0 14px 90px" }}>
      <MoveCard move={niftyMove} C={C} S={S} />
      <MoveCard move={goldMove} C={C} S={S} />
      <MoveCard move={silverMove} C={C} S={S} />

      <div style={{ ...S.card }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Market Overview</div>
        {INSTRUMENT_KEYS.map((name) => {
          const p = prices[name];
          if (!p) return null;
          const ch = +(p.cur - p.prev).toFixed(2);
          const pc = +((ch / p.prev) * 100).toFixed(2);
          return (
            <div key={name} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${C.dim}` }}>
              <div>
                <span style={{ color: C.text, fontWeight: 700 }}>{name}</span>
                {INSTRUMENT_SUB[name] && <div style={{ color: C.muted, fontSize: 9 }}>{INSTRUMENT_SUB[name]}</div>}
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: C.text }}>₹{fmt(p.cur, name === "NIFTY" ? 0 : 2)}</div>
                <div style={{ color: ch >= 0 ? C.green : C.red, fontSize: 11 }}>{ch >= 0 ? "+" : ""}{fmt(ch, name === "NIFTY" ? 0 : 2)} ({pc >= 0 ? "+" : ""}{pc}%)</div>
              </div>
            </div>
          );
        })}
        {newsOverview && <p style={{ color: C.muted, fontSize: 12, lineHeight: 1.5, marginTop: 10, marginBottom: 0 }}>{newsOverview}</p>}
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 10, overflowX: "auto" }}>
        {["All", "Market", "Earnings", "Sector", "Technical", "Corporate", "Global"].map((c) => (
          <button key={c} onClick={() => setNewsFilter(c)} style={{ padding: "5px 12px", borderRadius: 7, background: c === newsFilter ? C.green : C.card, color: c === newsFilter ? "#000" : C.muted, border: `1px solid ${C.border}`, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap", fontWeight: c === newsFilter ? 800 : 400 }}>{c}</button>
        ))}
      </div>

      {filteredNews.length ? filteredNews.map((n) => <NewsCard key={n.id} n={n} onClick={setSelNews} C={C} />)
        : <div style={{ ...S.card, textAlign: "center", color: C.muted }}>No news available</div>}
    </div>
  );

  const SettingsTab = () => (
    <div style={{ padding: "0 14px 90px" }}>
      <div style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {theme === "dark" ? <Moon size={16} color={C.muted} /> : <Sun size={16} color={C.yellow} />}
          <span style={{ color: C.text, fontWeight: 700 }}>Theme</span>
        </div>
        <Toggle on={theme === "light"} onToggle={() => setTheme(theme === "dark" ? "light" : "dark")} C={C} />
      </div>

      <div style={S.card}>
        <div style={{ color: C.text, fontWeight: 700, marginBottom: 8 }}>Refresh · <span style={{ color: C.green }}>{refresh}s</span></div>
        <input type="range" min={3} max={60} value={refresh} onChange={(e) => setRefresh(+e.target.value)} style={{ width: "100%", accentColor: C.green }} />
      </div>

      <div style={S.card}>
        <div style={{ color: C.text, fontWeight: 700, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}><Bell size={14} /> Alerts</div>
        {[{ k: "sound", l: "Sound" }, { k: "notification", l: "Notification" }].map(({ k, l }) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.dim}` }}>
            <span style={{ color: C.text, fontSize: 13 }}>{l}</span>
            <Toggle on={alerts[k]} onToggle={() => { if (k === "notification") requestNotifPerm(); setAlerts((p) => ({ ...p, [k]: !p[k] })); }} C={C} />
          </div>
        ))}
      </div>
    </div>
  );

  const NiftyLogTab = () => (
    <div style={{ padding: "0 14px 90px" }}>
      <div style={{ ...S.card, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <Zap size={16} color={C.yellow} />
          <span style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>NIFTY signal log</span>
        </div>
        <p style={{ color: C.muted, fontSize: 11, lineHeight: 1.5, margin: "0 0 10px" }}>
          Logs only high-conviction BUY/SELL signals ({NIFTY_LOG_MIN_CONFIDENCE}%+). Each prediction is graded against the real price path — it "passes" only after NIFTY moves at least {NIFTY_MIN_PASS_POINTS} points in its favour before hitting the stop-loss.
          {serverLogConfigured
            ? " Upstash sync is on — signals save to the server while you use the app."
            : " Add Upstash Redis + CRON_SECRET on Vercel to log in the background when the app is closed."}
        </p>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ color: C.muted, fontSize: 11 }}>
            {niftySignalLog.length} entries saved
            {serverLogConfigured && <span style={{ color: C.green }}> · server sync on</span>}
          </span>
          {niftySignalLog.length > 0 && (
            <button
              type="button"
              onClick={() => {
                if (!window.confirm("Clear all NIFTY signal log entries?")) return;
                setNiftySignalLog([]);
                prevNiftyLogRef.current = null;
                fetch("/api/nifty-log", { method: "DELETE" }).catch(() => {});
              }}
              style={{ padding: "6px 10px", borderRadius: 6, background: `${C.red}18`, border: `1px solid ${C.red}44`, color: C.red, fontSize: 11, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}
            >
              <Trash2 size={12} /> Clear log
            </button>
          )}
        </div>
      </div>

      {niftySignalLog.length > 0 && (() => {
        const stats = summarizeOutcomes(niftySignalLog);
        return (
          <div style={{ ...S.card, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
              <span style={{ color: C.text, fontWeight: 800, fontSize: 14 }}>Prediction accuracy</span>
              <span style={{ color: stats.winRate == null ? C.muted : stats.winRate >= 50 ? C.green : C.red, fontWeight: 900, fontSize: 18 }}>
                {stats.winRate == null ? "—" : `${stats.winRate}%`}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
              {[
                { l: "Passed", v: stats.passed, c: C.green },
                { l: "Failed", v: stats.failed, c: C.red },
                { l: "Active", v: stats.active, c: C.yellow },
                { l: "Expired", v: stats.expired, c: C.muted },
              ].map((s) => (
                <div key={s.l} style={{ background: C.dim, borderRadius: 8, padding: "8px 4px", textAlign: "center" }}>
                  <div style={{ color: s.c, fontWeight: 900, fontSize: 17 }}>{s.v}</div>
                  <div style={{ color: C.muted, fontSize: 9, textTransform: "uppercase" }}>{s.l}</div>
                </div>
              ))}
            </div>
            <p style={{ color: C.muted, fontSize: 10, margin: "10px 0 0", lineHeight: 1.4 }}>
              Win rate = passed ÷ (passed + failed). A signal "passes" only after NIFTY moves ≥{NIFTY_MIN_PASS_POINTS} points in its favour before the stop-loss.
            </p>
          </div>
        );
      })()}

      {niftySignalLog.length === 0 ? (
        <div style={{ ...S.card, textAlign: "center", color: C.muted, padding: 24 }}>
          No NIFTY BUY/SELL signals logged yet. Entries appear when confidence reaches {NIFTY_LOG_MIN_CONFIDENCE}%+ during market hours
          {serverLogConfigured ? " — logging continues on the server when the app is closed." : " — keep the app open, or enable server logging on Vercel."}
        </div>
      ) : (
        niftySignalLog.map((entry) => <NiftySignalLogRow key={entry.id} entry={entry} C={C} S={S} />)
      )}
    </div>
  );

  const TABS = [
    { id: "dashboard", Icon: Home, label: "Home" },
    { id: "portfolio", Icon: Briefcase, label: "Portfolio" },
    { id: "news", Icon: Newspaper, label: "News" },
    { id: "niftylog", Icon: ScrollText, label: "NIFTY Log" },
    { id: "settings", Icon: Settings, label: "Settings" },
  ];

  const CONTENT = { dashboard: Dashboard, news: NewsTab, niftylog: NiftyLogTab, settings: SettingsTab };
  const ActiveTab = CONTENT[tab];

  return (
    <div style={{ background: "transparent", minHeight: "100dvh", width: "100%", maxWidth: "min(100%, 960px)", margin: "0 auto", position: "relative", fontFamily: "'SF Pro Display',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", paddingBottom: 96, color: C.text }}>
      <div style={{ ...glassStyle(C), borderTop: "none", borderLeft: "none", borderRight: "none", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 50 }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 20, letterSpacing: -0.3, background: `linear-gradient(95deg, ${C.green}, ${C.blue})`, WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", display: "inline-block" }}>⚡ ScalpAI</div>
          <div style={{ color: C.muted, fontSize: 10 }}>{marketStatus.label} · {marketStatus.detail}</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div title={liveError || ""} style={{ display: "flex", alignItems: "center", gap: 5, background: isLive ? `${C.green}18` : `${C.yellow}18`, border: `1px solid ${isLive ? C.green : C.yellow}45`, borderRadius: 999, padding: "5px 11px", boxShadow: `${C.glow} ${isLive ? C.green : C.yellow}33` }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: isLive ? C.green : C.yellow }} />
            <span style={{ color: isLive ? C.green : C.yellow, fontSize: 11, fontWeight: 700 }}>{isLive ? "LIVE" : "DEMO"}</span>
          </div>
          <button onClick={() => setTab("news")} aria-label="News" style={{ background: tab === "news" ? `${C.yellow}2e` : `${C.yellow}14`, border: `1px solid ${C.yellow}55`, borderRadius: 999, padding: "6px 11px", color: C.yellow, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
            <Newspaper size={14} /><span style={{ fontSize: 11, fontWeight: 700 }}>News</span>
          </button>
          <button onClick={() => setTab("niftylog")} aria-label="NIFTY Log" style={{ background: tab === "niftylog" ? `${C.green}2e` : `${C.green}14`, border: `1px solid ${C.green}55`, borderRadius: 999, padding: "6px 11px", color: C.green, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
            <ScrollText size={14} /><span style={{ fontSize: 11, fontWeight: 700 }}>Log</span>
          </button>
          <button onClick={() => setChatOpen(true)} style={{ background: `linear-gradient(135deg, ${C.blue}33, ${C.blue}1a)`, border: `1px solid ${C.blue}66`, borderRadius: 999, padding: "6px 13px", color: C.blue, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, boxShadow: `${C.glow} ${C.blue}33` }}>
            <MessageCircle size={14} /><span style={{ fontSize: 11, fontWeight: 700 }}>AI</span>
          </button>
        </div>
      </div>

      <div style={{ padding: "14px 16px 6px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 4, height: 22, borderRadius: 4, background: `linear-gradient(180deg, ${C.green}, ${C.blue})` }} />
          <span style={{ color: C.text, fontWeight: 900, fontSize: 22, letterSpacing: -0.3 }}>{TABS.find((t) => t.id === tab)?.label}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, color: C.muted, fontSize: 11, background: `${C.dim}99`, border: `1px solid ${C.glassBorder}`, borderRadius: 999, padding: "4px 10px" }}><RefreshCw size={11} /> {refresh}s</div>
      </div>

      <div key={tab} style={{ paddingTop: 8, animation: "saIn .28s ease" }}>
        {tab === "portfolio" ? (
          <PortfolioTab
            portfolio={portfolio}
            suggestionItems={portfolioSuggestionItems}
            portfolioFundamentals={portfolioFundamentals}
            portfolioSignalLog={portfolioSignalLog}
            onSelectStock={setSelectedStock}
            onAddSymbol={addWatchStock}
            onRemoveStock={removePortfolioStock}
            onClearLog={clearPortfolioLog}
            csvRef={csvRef}
            onCsvChange={handleCSV}
            C={C}
            S={S}
          />
        ) : (
          ActiveTab && <ActiveTab />
        )}
      </div>

      <div style={{ position: "fixed", bottom: "max(14px, env(safe-area-inset-bottom))", left: 0, right: 0, margin: "0 auto", width: "calc(100% - 28px)", maxWidth: "min(calc(100% - 28px), 460px)", zIndex: 50, ...glassStyle(C), borderRadius: 22, display: "flex", justifyContent: "space-around", padding: "8px 6px", boxShadow: C.shadow }}>
        {TABS.filter((t) => t.id !== "news" && t.id !== "niftylog").map(({ id, Icon, label }) => {
          const active = tab === id;
          return (
            <button key={id} onClick={() => setTab(id)} style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "8px 12px", borderRadius: 16, background: active ? `linear-gradient(135deg, ${C.green}26, ${C.blue}14)` : "transparent", border: active ? `1px solid ${C.green}44` : "1px solid transparent", cursor: "pointer", minWidth: 0, boxShadow: active ? `${C.glow} ${C.green}33` : "none" }}>
              <Icon size={19} color={active ? C.green : C.muted} />
              <span style={{ fontSize: 9, color: active ? C.green : C.muted, fontWeight: active ? 800 : 500 }}>{label}</span>
            </button>
          );
        })}
      </div>

      {selectedStock && (
        <StockDetailModal
          key={selectedStock.id ?? selectedStock.name}
          stock={selectedStock}
          news={news}
          sett={sett}
          eaState={eaState}
          onAskEA={askEA}
          onClose={() => setSelectedStock(null)}
          C={C}
          S={S}
        />
      )}

      {selNews && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)", zIndex: 200, display: "flex", alignItems: "flex-end" }} onClick={() => setSelNews(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...glassStyle(C), borderRadius: "22px 22px 0 0", padding: 20, width: "100%", maxHeight: "72vh", overflowY: "auto", boxShadow: C.shadow }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <span style={{ color: C.green, fontSize: 11, fontWeight: 700 }}>{selNews.cat} · {selNews.impact}</span>
              <button onClick={() => setSelNews(null)} style={{ background: C.dim, border: "none", color: C.muted, cursor: "pointer", borderRadius: 6, padding: 4 }}><X size={16} /></button>
            </div>
            <p style={{ color: C.text, fontWeight: 700, fontSize: 16, marginBottom: 12 }}>{selNews.headline}</p>
            <p style={{ color: C.muted, fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>{selNews.detail}</p>
            {selNews.marketImpact && (
              <div style={{ background: C.dim, borderRadius: 8, padding: 12, marginBottom: 12 }}>
                <div style={{ color: C.yellow, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>How this affects the market</div>
                <p style={{ color: C.text, fontSize: 13, lineHeight: 1.5, margin: 0 }}>{selNews.marketImpact}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {chatOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", flexDirection: "column", background: C.bg, backgroundImage: C.bgGrad }}>
          <div style={{ ...glassStyle(C), borderTop: "none", borderLeft: "none", borderRight: "none", padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>⚡ AI Assistant</div>
              <div style={{ color: C.muted, fontSize: 10, marginBottom: 8 }}>Powered by Google Gemini</div>
              <select
                value={chatModel}
                onChange={(e) => setChatModel(e.target.value)}
                style={{ width: "100%", maxWidth: 280, padding: "6px 10px", borderRadius: 8, background: C.dim, color: C.text, border: `1px solid ${C.border}`, fontSize: 12, outline: "none" }}
              >
                {GEMINI_CHAT_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
            <button onClick={() => setChatOpen(false)} style={{ background: C.dim, border: "none", color: C.muted, cursor: "pointer", borderRadius: 8, padding: 6, flexShrink: 0 }}><X size={18} /></button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
            {msgs.map((m, i) => (
              <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 14 }}>
                <div style={{ maxWidth: "82%", background: m.role === "user" ? `${C.blue}22` : C.card, border: `1px solid ${m.role === "user" ? C.blue + "45" : C.border}`, borderRadius: m.role === "user" ? "16px 4px 16px 16px" : "4px 16px 16px 16px", padding: "10px 14px" }}>
                  <div style={{ color: C.text, fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{m.content}</div>
                </div>
              </div>
            ))}
            {chatLoading && <div style={{ color: C.muted, fontSize: 12 }}>Thinking…</div>}
            <div ref={chatEnd} />
          </div>
          <div style={{ ...glassStyle(C), borderBottom: "none", borderLeft: "none", borderRight: "none", padding: "10px 16px max(16px, env(safe-area-inset-bottom))", display: "flex", gap: 8 }}>
            <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendMsg()} placeholder="Ask or control the app…" style={{ flex: 1, padding: 12, borderRadius: 14, background: C.dim, color: C.text, border: `1px solid ${C.glassBorder}`, fontSize: 14, outline: "none" }} />
            <button onClick={sendMsg} disabled={chatLoading} style={{ padding: "12px 14px", borderRadius: 14, background: chatLoading ? C.dim : `linear-gradient(135deg, ${C.green}, ${C.blue})`, border: "none", cursor: chatLoading ? "not-allowed" : "pointer", boxShadow: chatLoading ? "none" : `${C.glow} ${C.green}44` }}><Send size={18} color={chatLoading ? C.muted : "#000"} /></button>
          </div>
        </div>
      )}

      <style>{`
        html, body { margin: 0; padding: 0; min-height: 100%; overflow-x: hidden; overflow-y: auto; -webkit-overflow-scrolling: touch; background: ${C.bg}; background-image: ${C.bgGrad}; background-attachment: fixed; background-repeat: no-repeat; color: ${C.text}; }
        * { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        input[type=range] { cursor: pointer; accent-color: ${C.green}; }
        button { transition: transform .12s ease, background .2s ease, border-color .2s ease, box-shadow .2s ease; }
        button:active { transform: scale(0.97); }
        @keyframes saIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  );
}
