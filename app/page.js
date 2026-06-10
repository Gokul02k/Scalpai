"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  AreaChart, Area, BarChart, Bar, YAxis,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  Settings, ChevronDown,   MessageCircle, X, Send, Newspaper, BarChart2,
  Briefcase, Home, ArrowUp, ArrowDown, Zap, RefreshCw, Star,
  Upload, Plus, Trash2, Bell, Sun, Moon, Lightbulb,
} from "lucide-react";
import {
  fetchAllMarketData, fetchCandles, fetchPortfolioPrices, fetchNews, fetchStockQuote, genFallbackCandles,
} from "./lib/marketData";
import { analyzeFromCandles } from "./lib/indicators";
import { generateIndexSignals, generatePortfolioSignals, parsePortfolioCSV } from "./lib/signals";
import { buildUnifiedSuggestion, explainAssetMove, getWatchlistMarketSuggestion, getStockSuggestion } from "./lib/suggestion";
import { loadPersisted, savePersisted } from "./lib/storage";
import { getMarketStatus } from "./lib/marketHours";
import { THEMES, cardStyle } from "./lib/themes";
import { GROQ_CHAT_MODELS, DEFAULT_GROQ_MODEL } from "./lib/groqModels";

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

const fmt  = (n, d = 2) => n?.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }) ?? "—";
const fmtD = (n) => (n >= 0 ? "+" : "") + fmt(n);
const todayStr = () => new Date().toISOString().slice(0, 10);

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

function filterTradesByPeriod(trades, period) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfDay.getDate() - startOfDay.getDay());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  return trades.filter((t) => {
    const d = new Date(t.date || todayStr());
    if (period === "today") return d >= startOfDay;
    if (period === "week") return d >= startOfWeek;
    return d >= startOfMonth;
  });
}

function CandleChart({ candles = [], height = 200, C }) {
  if (!candles.length) return null;
  const W = 800, PAD = 10, H = height, ch = H - PAD * 2;
  const maxP = Math.max(...candles.map((c) => c.h));
  const minP = Math.min(...candles.map((c) => c.l));
  const range = maxP - minP || 1;
  const toY = (p) => PAD + ((maxP - p) / range) * ch;
  const sw = W / candles.length;
  const bw = Math.max(2, sw * 0.6);
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block" }}>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={0} y1={PAD + f * ch} x2={W} y2={PAD + f * ch} stroke={C.border} strokeWidth={0.6} />
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

function InstrumentDropdown({ instrument, setInstrument, open, setOpen, isUp, marketStatus, C }) {
  return (
    <div style={{ position: "relative", marginBottom: 12 }}>
      <button onClick={() => setOpen(!open)} style={{ display: "flex", alignItems: "center", gap: 8, background: C.card, border: `1px solid ${isUp ? C.green + "60" : C.red + "60"}`, borderRadius: 10, padding: "10px 14px", color: C.text, fontSize: 15, fontWeight: 800, cursor: "pointer", width: "100%" }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: marketStatus.open ? C.green : C.yellow, boxShadow: `0 0 6px ${marketStatus.open ? C.green : C.yellow}` }} />
        {instrument}
        <ChevronDown size={15} style={{ marginLeft: "auto", color: C.muted }} />
      </button>
      {open && (
        <div style={{ position: "absolute", top: "105%", left: 0, right: 0, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, zIndex: 100 }}>
          {INSTRUMENT_KEYS.map((k) => (
            <button key={k} onClick={() => { setInstrument(k); setOpen(false); }} style={{ display: "flex", width: "100%", padding: "12px 16px", background: k === instrument ? `${C.green}18` : "transparent", color: k === instrument ? C.green : C.text, border: "none", cursor: "pointer", fontSize: 14, fontWeight: k === instrument ? 800 : 400, borderBottom: `1px solid ${C.border}` }}>{k}</button>
          ))}
        </div>
      )}
    </div>
  );
}

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

function HomeSuggestionBlock({ name, badge, finalCall, priceData, eaKey, eaState, onAskEA, C, S }) {
  if (!finalCall) return null;
  const { action, label, confidence, factors, entry, target, stopLoss, rr } = finalCall;
  const clr = action === "BUY" ? C.green : action === "SELL" ? C.red : C.yellow;
  const cp = priceData?.cur ?? 0;
  const chg = priceData ? +(cp - priceData.prev).toFixed(2) : 0;
  const pct = priceData?.prev ? +((chg / priceData.prev) * 100).toFixed(2) : 0;
  const isUp = chg >= 0;
  const priceDecimals = name === "NIFTY" ? 0 : 2;

  return (
    <div style={{ ...S.card, borderColor: `${clr}55`, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <Lightbulb size={15} color={clr} />
        <span style={{ color: C.text, fontWeight: 800, fontSize: 16 }}>{name}</span>
        {badge && (
          <span style={{ background: `${C.blue}28`, color: C.blue, fontSize: 9, fontWeight: 800, padding: "2px 8px", borderRadius: 4 }}>{badge}</span>
        )}
      </div>
      {priceData && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <span style={{ color: C.text, fontWeight: 900, fontSize: 20 }}>₹{fmt(cp, priceDecimals)}</span>
          <span style={{ color: isUp ? C.green : C.red, fontSize: 12, fontWeight: 700 }}>
            {isUp ? <ArrowUp size={11} style={{ verticalAlign: "middle" }} /> : <ArrowDown size={11} style={{ verticalAlign: "middle" }} />}
            {" "}{(chg >= 0 ? "+" : "") + fmt(chg, priceDecimals)} ({pct >= 0 ? "+" : ""}{pct}%)
          </span>
        </div>
      )}

      <FinalCallHeader label={label} confidence={confidence} action={action} C={C} />
      <TradeLevelsRow entry={entry} target={target} stopLoss={stopLoss} rr={rr} action={action} decimals={priceDecimals} C={C} />

      <AskEASection
        eaKey={eaKey || name}
        instrument={name}
        mode={badge || "scalp"}
        finalCall={finalCall}
        priceData={priceData}
        eaState={eaState}
        onAskEA={onAskEA}
        C={C}
      />

      {factors.length > 0 && (
        <div style={{ borderTop: `1px solid ${C.dim}`, paddingTop: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <Zap size={13} color={C.yellow} />
            <span style={{ color: C.muted, fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>Signals in play</span>
          </div>
          {factors.map((f, i) => <SignalFactorRow key={i} factor={f} C={C} />)}
        </div>
      )}
    </div>
  );
}

function HomeCommodityBlock({ name, priceData, swingCall, longCall, eaState, onAskEA, C, S }) {
  const cp = priceData?.cur ?? 0;
  const chg = priceData ? +(cp - priceData.prev).toFixed(2) : 0;
  const pct = priceData?.prev ? +((chg / priceData.prev) * 100).toFixed(2) : 0;
  const isUp = chg >= 0;

  return (
    <div style={{ ...S.card, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <Lightbulb size={15} color={C.yellow} />
        <span style={{ color: C.text, fontWeight: 800, fontSize: 16 }}>{name}</span>
      </div>
      {priceData && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <span style={{ color: C.text, fontWeight: 900, fontSize: 20 }}>₹{fmt(cp, 2)}</span>
          <span style={{ color: isUp ? C.green : C.red, fontSize: 12, fontWeight: 700 }}>
            {isUp ? <ArrowUp size={11} style={{ verticalAlign: "middle" }} /> : <ArrowDown size={11} style={{ verticalAlign: "middle" }} />}
            {" "}{(chg >= 0 ? "+" : "") + fmt(chg, 2)} ({pct >= 0 ? "+" : ""}{pct}%)
          </span>
        </div>
      )}

      {[{ call: swingCall, title: "Swing trade", key: `${name}_swing`, mode: "swing" }, { call: longCall, title: "Long term (~1 month)", key: `${name}_long`, mode: "longterm" }].map(({ call, title, key, mode }) => {
        if (!call) return null;
        return (
          <div key={title} style={{ marginBottom: 16, paddingBottom: 16, borderBottom: `1px solid ${C.dim}` }}>
            <div style={{ color: C.muted, fontSize: 10, fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>{title}</div>
            <FinalCallHeader label={call.label} confidence={call.confidence} action={call.action} C={C} />
            <TradeLevelsRow entry={call.entry} target={call.target} stopLoss={call.stopLoss} rr={call.rr} action={call.action} decimals={2} C={C} />
            <AskEASection
              eaKey={key}
              instrument={name}
              mode={mode}
              finalCall={call}
              priceData={priceData}
              eaState={eaState}
              onAskEA={onAskEA}
              C={C}
            />
            {call.factors?.length > 0 && (
              <div style={{ marginTop: 4 }}>
                {call.factors.slice(0, 4).map((f, i) => <SignalFactorRow key={i} factor={f} C={C} />)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function WatchlistSuggestionRow({ symbol, quote, suggestion, C, S }) {
  const clr = suggestion.action === "BUY" ? C.green : suggestion.action === "SELL" ? C.red : C.yellow;
  const pct = quote?.changePercent ?? 0;
  return (
    <div style={{ ...S.card, marginBottom: 8, borderColor: `${clr}33`, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
        <div>
          <div style={{ color: C.text, fontWeight: 800, fontSize: 14 }}>{symbol}</div>
          <div style={{ color: C.muted, fontSize: 11 }}>
            {quote?.current ? `₹${fmt(quote.current)} · today ${pct >= 0 ? "+" : ""}${pct}%` : "Loading…"}
          </div>
        </div>
        <span style={{ background: clr, color: suggestion.action === "HOLD" || suggestion.action === "WAIT" ? C.text : "#000", fontSize: 9, fontWeight: 800, padding: "3px 8px", borderRadius: 4, flexShrink: 0 }}>
          {suggestion.label}
        </span>
      </div>
      <p style={{ color: C.text, fontSize: 12, lineHeight: 1.45, margin: 0 }}>{suggestion.reason}</p>
    </div>
  );
}

function WatchlistTab({
  watchlists,
  activeWatchlist,
  onActiveWatchlistChange,
  watchInput,
  onWatchInputChange,
  watchPrices,
  onAdd,
  onRemove,
  C,
  S,
}) {
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const inputRef = useRef(null);
  const currentSymbols = watchlists[activeWatchlist] || [];

  const suggestions = useMemo(
    () => filterStockSuggestions(watchInput, currentSymbols),
    [watchInput, currentSymbols.join(",")]
  );

  const submitSymbol = (symbol) => {
    const sym = (symbol || watchInput).trim().toUpperCase();
    if (!sym) return;
    onAdd(sym);
    onWatchInputChange("");
    setSuggestionsOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div style={{ padding: "0 14px 90px" }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 10, overflowX: "auto" }}>
        {Object.keys(watchlists).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => onActiveWatchlistChange(name)}
            style={{
              padding: "6px 12px",
              borderRadius: 8,
              background: activeWatchlist === name ? C.green : C.card,
              color: activeWatchlist === name ? "#000" : C.muted,
              border: `1px solid ${C.border}`,
              fontSize: 11,
              cursor: "pointer",
              whiteSpace: "nowrap",
              fontWeight: 700,
            }}
          >
            {name}
          </button>
        ))}
      </div>

      <div style={{ ...S.card, position: "relative" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={inputRef}
            type="text"
            value={watchInput}
            onChange={(e) => {
              onWatchInputChange(e.target.value.toUpperCase());
              setSuggestionsOpen(true);
            }}
            onFocus={() => setSuggestionsOpen(true)}
            onBlur={() => setTimeout(() => setSuggestionsOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (suggestions.length) submitSymbol(suggestions[0]);
                else submitSymbol();
              }
            }}
            placeholder="Search stock (e.g. RELIANCE)"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            style={{
              flex: 1,
              padding: 10,
              borderRadius: 8,
              background: C.dim,
              color: C.text,
              border: `1px solid ${C.border}`,
              fontSize: 16,
              outline: "none",
            }}
          />
          <button
            type="button"
            onClick={() => submitSymbol()}
            style={{ padding: "10px 14px", background: C.green, border: "none", borderRadius: 8, cursor: "pointer", flexShrink: 0 }}
          >
            <Plus size={16} color="#000" />
          </button>
        </div>

        {suggestionsOpen && watchInput.trim() && suggestions.length > 0 && (
          <div
            style={{
              position: "absolute",
              left: 12,
              right: 12,
              top: "calc(100% - 4px)",
              zIndex: 20,
              background: C.card,
              border: `1px solid ${C.border}`,
              borderRadius: 8,
              maxHeight: 220,
              overflowY: "auto",
              boxShadow: `0 8px 24px ${C.bg}88`,
            }}
          >
            {suggestions.map((sym) => (
              <button
                key={sym}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => submitSymbol(sym)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 12px",
                  background: "transparent",
                  border: "none",
                  borderBottom: `1px solid ${C.dim}`,
                  color: C.text,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {sym}
              </button>
            ))}
          </div>
        )}
      </div>

      {currentSymbols.map((sym) => (
        <div key={sym} style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ color: C.text, fontWeight: 800, fontSize: 14 }}>{sym}</div>
            <div style={{ color: C.muted, fontSize: 11 }}>{watchPrices[sym] ? `₹${fmt(watchPrices[sym])}` : "Loading…"}</div>
          </div>
          <button
            type="button"
            onClick={() => onRemove(sym)}
            style={{ background: `${C.red}18`, border: "none", borderRadius: 6, padding: 6, cursor: "pointer" }}
          >
            <Trash2 size={14} color={C.red} />
          </button>
        </div>
      ))}
      {!currentSymbols.length && (
        <div style={{ ...S.card, textAlign: "center", color: C.muted }}>Watchlist empty</div>
      )}
    </div>
  );
}

function PortfolioTab({
  portfolioSubTab,
  onPortfolioSubTabChange,
  portfolio,
  newStock,
  onNewStockChange,
  onAddStock,
  onRemoveStock,
  portVal,
  portPnL,
  portCost,
  portfolioStocks,
  portSignals,
  portfolioStockNews,
  cp,
  sett,
  csvRef,
  onCsvChange,
  onNewsSelect,
  C,
  S,
}) {
  const [symbolSuggestionsOpen, setSymbolSuggestionsOpen] = useState(false);
  const symbolInputRef = useRef(null);
  const retPct = portCost ? +((portPnL / portCost) * 100).toFixed(2) : 0;
  const subTabs = [
    { id: "holdings", label: "Holdings" },
    { id: "suggestions", label: "Suggestions" },
    { id: "news", label: "Stock News" },
  ];
  const heldSymbols = portfolio.map((s) => s.name);
  const symbolSuggestions = useMemo(
    () => filterStockSuggestions(newStock.name, heldSymbols),
    [newStock.name, heldSymbols.join(",")]
  );

  const pickSymbol = (sym) => {
    onNewStockChange({ ...newStock, name: sym });
    setSymbolSuggestionsOpen(false);
    symbolInputRef.current?.focus();
  };

  return (
    <div style={{ padding: "0 14px 90px" }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {subTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onPortfolioSubTabChange(t.id)}
            style={{
              flex: 1,
              padding: "9px 8px",
              borderRadius: 8,
              background: portfolioSubTab === t.id ? C.green : C.card,
              color: portfolioSubTab === t.id ? "#000" : C.muted,
              border: `1px solid ${C.border}`,
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {portfolioSubTab === "holdings" && (
        <>
          <div style={{ ...S.card, background: `linear-gradient(135deg,${C.card},${C.dim})` }}>
            <div style={{ color: C.muted, fontSize: 10, marginBottom: 4, textTransform: "uppercase" }}>Total Value</div>
            <div style={{ color: C.text, fontSize: 27, fontWeight: 900 }}>₹{fmt(portVal, 0)}</div>
            <div style={{ color: portPnL >= 0 ? C.green : C.red, fontSize: 14, fontWeight: 700 }}>{portPnL >= 0 ? "+" : ""}₹{fmt(portPnL, 0)} ({retPct >= 0 ? "+" : ""}{retPct}%)</div>
          </div>

          <input ref={csvRef} type="file" accept=".csv,.txt" style={{ display: "none" }} onChange={onCsvChange} />
          <button type="button" onClick={() => csvRef.current?.click()} style={{ width: "100%", padding: 12, borderRadius: 10, marginBottom: 10, background: `${C.blue}18`, border: `1px dashed ${C.blue}55`, color: C.blue, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <Upload size={14} /> Import CSV
          </button>
          <p style={{ color: C.muted, fontSize: 11, margin: "0 0 12px", lineHeight: 1.4 }}>
            Upload a Groww/Zerodha CSV to load holdings, or add stocks below. Ask EA in chat to add/remove stocks by name.
          </p>

          <div style={{ ...S.card, marginBottom: 12, position: "relative" }}>
            <div style={{ color: C.muted, fontSize: 10, fontWeight: 700, textTransform: "uppercase", marginBottom: 8 }}>Add stock</div>
            <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <input
                ref={symbolInputRef}
                type="text"
                value={newStock.name}
                onChange={(e) => {
                  onNewStockChange({ ...newStock, name: e.target.value.toUpperCase() });
                  setSymbolSuggestionsOpen(true);
                }}
                onFocus={() => setSymbolSuggestionsOpen(true)}
                onBlur={() => setTimeout(() => setSymbolSuggestionsOpen(false), 150)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (symbolSuggestions.length) pickSymbol(symbolSuggestions[0]);
                  }
                }}
                placeholder="Symbol"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="next"
                style={{ flex: 2, padding: 10, borderRadius: 8, background: C.dim, border: `1px solid ${C.border}`, color: C.text, fontSize: 16, outline: "none" }}
              />
              <input
                type="number"
                value={newStock.qty}
                onChange={(e) => onNewStockChange({ ...newStock, qty: e.target.value })}
                placeholder="Qty"
                autoComplete="off"
                enterKeyHint="next"
                style={{ flex: 1, padding: 10, borderRadius: 8, background: C.dim, border: `1px solid ${C.border}`, color: C.text, fontSize: 16, outline: "none" }}
              />
              <input
                type="number"
                value={newStock.buy}
                onChange={(e) => onNewStockChange({ ...newStock, buy: e.target.value })}
                placeholder="Avg ₹"
                autoComplete="off"
                enterKeyHint="done"
                style={{ flex: 1, padding: 10, borderRadius: 8, background: C.dim, border: `1px solid ${C.border}`, color: C.text, fontSize: 16, outline: "none" }}
              />
            </div>

            {symbolSuggestionsOpen && newStock.name.trim() && symbolSuggestions.length > 0 && (
              <div
                style={{
                  position: "absolute",
                  left: 12,
                  right: 12,
                  top: 72,
                  zIndex: 20,
                  background: C.card,
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  maxHeight: 200,
                  overflowY: "auto",
                  boxShadow: `0 8px 24px ${C.bg}88`,
                }}
              >
                {symbolSuggestions.map((sym) => (
                  <button
                    key={sym}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickSymbol(sym)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "10px 12px",
                      background: "transparent",
                      border: "none",
                      borderBottom: `1px solid ${C.dim}`,
                      color: C.text,
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    {sym}
                  </button>
                ))}
              </div>
            )}

            <button type="button" onClick={onAddStock} style={{ width: "100%", padding: 10, borderRadius: 8, background: C.green, color: "#000", fontWeight: 800, fontSize: 12, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
              <Plus size={14} /> Add to portfolio
            </button>
          </div>

          {portfolio.length === 0 && (
            <div style={{ ...S.card, textAlign: "center", color: C.muted, marginBottom: 12 }}>No holdings yet. Import a CSV or add stocks manually.</div>
          )}

          {portfolio.map((s) => {
            const pnl = (s.cur - s.buy) * s.qty;
            const pnlPct = s.buy ? +((s.cur - s.buy) / s.buy * 100).toFixed(2) : 0;
            const up = pnl >= 0;
            return (
              <div key={s.id} style={{ ...S.card, borderColor: up ? `${C.green}35` : `${C.red}35` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>{s.name}</div>
                    <div style={{ color: C.muted, fontSize: 11 }}>{s.sector} · {s.qty} shares · Avg ₹{fmt(s.buy)}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>₹{fmt(s.cur)}</div>
                      <div style={{ color: up ? C.green : C.red, fontSize: 12, fontWeight: 700 }}>{up ? "+" : ""}₹{fmt(pnl, 0)} ({pnlPct >= 0 ? "+" : ""}{pnlPct}%)</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveStock(s.id)}
                      aria-label={`Remove ${s.name}`}
                      style={{ padding: 6, borderRadius: 6, background: `${C.red}18`, border: `1px solid ${C.red}44`, color: C.red, cursor: "pointer" }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </>
      )}

      {portfolioSubTab === "suggestions" && (
        <>
          {portfolioStocks.length === 0 && (
            <div style={{ ...S.card, textAlign: "center", color: C.muted }}>Add stocks to your portfolio to see buy/sell suggestions.</div>
          )}
          {portfolioStocks.map((s) => {
            const sug = getStockSuggestion(s, sett);
            const clr = sug.action === "BUY" ? C.green : sug.action === "SELL" ? C.red : C.yellow;
            return (
              <div key={s.id} style={{ ...S.card, borderColor: `${clr}44` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                  <div>
                    <div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>{s.name}</div>
                    <div style={{ color: C.muted, fontSize: 11 }}>₹{fmt(s.cur)} · Avg ₹{fmt(s.buy)}</div>
                  </div>
                  <span style={{ background: clr, color: sug.action === "HOLD" || sug.action === "WAIT" ? C.text : "#000", fontSize: 10, fontWeight: 800, padding: "3px 10px", borderRadius: 4 }}>
                    {sug.label}
                  </span>
                </div>
                <p style={{ color: C.text, fontSize: 12, lineHeight: 1.5, margin: "0 0 4px" }}>{sug.reason}</p>
                <p style={{ color: C.muted, fontSize: 11, margin: 0 }}>{sug.detail}</p>
              </div>
            );
          })}
          {portSignals.filter((sig) => portfolioStocks.some((s) => s.name === sig.instrument)).map((sig, i) => (
            <SignalCard key={`sig-${i}`} sig={sig} price={sig.target || cp} C={C} />
          ))}
        </>
      )}

      {portfolioSubTab === "news" && (
        <>
          {portfolioStockNews.length === 0 ? (
            <div style={{ ...S.card, textAlign: "center", color: C.muted }}>No news found for your portfolio stocks.</div>
          ) : (
            portfolioStockNews.map((n) => <NewsCard key={n.id} n={n} onClick={onNewsSelect} C={C} />)
          )}
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
  const [chartsDropOpen, setChartsDropOpen] = useState(false);
  const [portfolioSubTab, setPortfolioSubTab] = useState("holdings");
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
  const [trades, setTrades] = useState([]);
  const [tradePeriod, setTradePeriod] = useState("today");
  const [addTrade, setAddTrade] = useState(false);
  const [newT, setNewT] = useState({ ins: "NIFTY", type: "BUY", entry: "", qty: 1, date: todayStr() });

  const [news, setNews] = useState([]);
  const [newsOverview, setNewsOverview] = useState("");
  const [selNews, setSelNews] = useState(null);
  const [newsFilter, setNewsFilter] = useState("All");

  const [watchlists, setWatchlists] = useState(DEFAULT_WATCHLISTS);
  const [activeWatchlist, setActiveWatchlist] = useState("My Watchlist");
  const [watchInput, setWatchInput] = useState("");
  const [watchPrices, setWatchPrices] = useState({});
  const [watchQuotes, setWatchQuotes] = useState({});

  const [sett, setSett] = useState({
    riskLimit: 10000, profitPct: 1.5, slPct: 0.8,
    ind: { rsi: true, macd: true, bb: true, ema20: true, ema50: true, vol: true },
  });
  const [alerts, setAlerts] = useState({ sound: true, notification: true });

  const [activeScalp, setActiveScalp] = useState(null);
  const [scalpElapsed, setScalpElapsed] = useState(0);
  const [marketStatus, setMarketStatus] = useState(() => getMarketStatus());

  const [chatOpen, setChatOpen] = useState(false);
  const [msgs, setMsgs] = useState([
    { role: "assistant", content: "👋 Hi! I'm your EA assistant.\n\nTry: \"Add RELIANCE 10 shares at 2850\", \"Remove TCS from portfolio\", \"Switch to GOLD\", or \"What does RSI say for NIFTY?\"" },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatModel, setChatModel] = useState(DEFAULT_GROQ_MODEL);
  const [chatLoading, setChatLoading] = useState(false);
  const [eaState, setEaState] = useState({});
  const chatEnd = useRef(null);
  const csvRef = useRef(null);
  const [newStock, setNewStock] = useState({ name: "", qty: "", buy: "" });
  const portfolioRef = useRef(portfolio);
  const pricesRef = useRef(prices);
  portfolioRef.current = portfolio;
  pricesRef.current = prices;
  const stockNamesKey = portfolio.map((p) => p.name).sort().join(",");

  // Hydrate from localStorage
  useEffect(() => {
    const data = loadPersisted();
    if (data) {
      if (data.theme) setTheme(data.theme);
      if (data.portfolio?.length) setPortfolio(data.portfolio);
      if (data.trades) setTrades(data.trades);
      if (data.watchlists) setWatchlists(data.watchlists);
      if (data.activeWatchlist) setActiveWatchlist(data.activeWatchlist);
      if (data.sett) setSett(data.sett);
      if (data.refresh) setRefresh(data.refresh);
      if (data.alerts) setAlerts(data.alerts);
      if (data.activeScalp) setActiveScalp(data.activeScalp);
      if (data.chatModel && GROQ_CHAT_MODELS.some((m) => m.id === data.chatModel)) setChatModel(data.chatModel);
    }
    setHydrated(true);
  }, []);

  // Persist on change
  useEffect(() => {
    if (!hydrated) return;
    savePersisted({ theme, portfolio, trades, watchlists, activeWatchlist, sett, refresh, alerts, activeScalp, chatModel });
  }, [hydrated, theme, portfolio, trades, watchlists, activeWatchlist, sett, refresh, alerts, activeScalp, chatModel]);

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

  // Portfolio + watchlist only — for Home stock suggestions
  const homeStockSymbols = useMemo(() => {
    const port = portfolio
      .filter((s) => !MACRO_SYMBOLS.has(s.name.toUpperCase()))
      .map((s) => s.name.toUpperCase());
    const watch = [...new Set(Object.values(watchlists).flat())]
      .map((s) => s.toUpperCase())
      .filter((s) => !MACRO_SYMBOLS.has(s));
    return [...new Set([...port, ...watch])];
  }, [portfolio, watchlists]);

  useEffect(() => {
    const syms = homeStockSymbols;
    if (!syms.length) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(syms.map(async (s) => {
        const q = await fetchStockQuote(s);
        return [s, q];
      }));
      if (!cancelled) {
        setWatchQuotes(Object.fromEntries(entries.filter(([, q]) => q)));
        setWatchPrices(Object.fromEntries(entries.map(([s, q]) => [s, q?.current ?? null])));
      }
    })();
    return () => { cancelled = true; };
  }, [homeStockSymbols.join(","), refresh]);

  useEffect(() => {
    const syms = watchlists[activeWatchlist] || [];
    if (!syms.length || syms.every((s) => watchPrices[s] != null)) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(syms.map(async (s) => {
        const q = await fetchStockQuote(s);
        return [s, q?.current ?? null];
      }));
      if (!cancelled) setWatchPrices((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    })();
    return () => { cancelled = true; };
  }, [watchlists, activeWatchlist, refresh]);

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

  const instCandles = candles[instrument] || [];
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

  useEffect(() => {
    if (!activeScalp) { setScalpElapsed(0); return; }
    const start = activeScalp.startTime || Date.now();
    setScalpElapsed(Date.now() - start);
    const id = setInterval(() => setScalpElapsed(Date.now() - start), 1000);
    return () => clearInterval(id);
  }, [activeScalp]);

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  const P = prices[instrument];
  const cp = P?.cur ?? 0;
  const chg = +(cp - (P?.prev ?? cp)).toFixed(2);
  const pct = +((chg / (P?.prev ?? cp)) * 100).toFixed(2);
  const isUp = chg >= 0;

  const filteredTrades = filterTradesByPeriod(trades, tradePeriod);
  const totPnL = filteredTrades.reduce((s, t) => s + t.pnl, 0);
  const winRate = filteredTrades.length ? Math.round(filteredTrades.filter((t) => t.win).length / filteredTrades.length * 100) : 0;
  const portPnL = portfolio.reduce((s, p) => s + (p.cur - p.buy) * p.qty, 0);
  const portVal = portfolio.reduce((s, p) => s + p.cur * p.qty, 0);
  const portCost = portfolio.reduce((s, p) => s + p.buy * p.qty, 0);

  const upsertPortfolioStock = useCallback((name, qty, buy, sector = "Other") => {
    const sym = String(name).toUpperCase().replace(/\.NS$/, "");
    const q = +qty || 1;
    const price = +buy || 0;
    setPortfolio((p) => {
      const existing = p.find((s) => s.name.toUpperCase() === sym);
      if (existing) {
        return p.map((s) => s.name.toUpperCase() === sym
          ? { ...s, qty: q, buy: price || s.buy, cur: price || s.cur, sector: sector || s.sector }
          : s);
      }
      return [...p, { id: Date.now(), name: sym, qty: q, buy: price, cur: price, sector }];
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
      if (action === "addToWatchlist") {
        const sym = (value.symbol || value).toUpperCase();
        setWatchlists((w) => ({ ...w, [activeWatchlist]: [...new Set([...(w[activeWatchlist] || []), sym])] }));
      }
      if (action === "switchTab") setTab(value);
    } catch (_) {}
  }, [activeWatchlist, upsertPortfolioStock, removePortfolioStock]);

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
      const sys = `You are EA, the AI assistant for ScalpAI (Indian markets).
Instrument: ${instrument} @ ₹${fmt(cp)} | RSI: ${analysis?.rsi ?? "—"} | Theme: ${theme}
Portfolio: ${portSummary}

When the user asks to add, update, or remove portfolio holdings, emit a command (user does not upload CSV in chat):
<CMD>{"action":"addStock","value":{"name":"RELIANCE","qty":10,"price":2850,"sector":"Energy"}}</CMD>
<CMD>{"action":"updateStock","value":{"name":"RELIANCE","qty":15,"price":2900}}</CMD>
<CMD>{"action":"removeStock","value":{"name":"TCS"}}</CMD>

Other commands via <CMD>{"action":"...","value":"..."}</CMD>:
changeInstrument, changeTimeframe, changeRefreshRate, toggleIndicator, setRiskLimit, setTheme, addToWatchlist, switchTab
Tabs: dashboard|charts|portfolio|news|watchlist|settings`;
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

  const addPortfolioStock = useCallback(() => {
    const name = newStock.name.trim();
    if (!name) return;
    upsertPortfolioStock(name, newStock.qty || 1, newStock.buy || 0);
    setNewStock({ name: "", qty: "", buy: "" });
  }, [newStock, upsertPortfolioStock]);

  // Kept for Trades tab when re-enabled
  const logTrade = () => {
    const entry = parseFloat(newT.entry) || cp;
    const exit = entry + (newT.type === "BUY" ? 15 : -15);
    const pnl = newT.type === "BUY" ? exit - entry : entry - exit;
    setTrades((p) => [{
      id: Date.now(), ins: newT.ins, type: newT.type, entry, exit, pnl, win: pnl > 0,
      date: newT.date, time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }), dur: "—",
    }, ...p]);
    setAddTrade(false);
    setNewT({ ins: instrument, type: "BUY", entry: "", date: new Date().toISOString().slice(0, 10) });
  };

  const addToWatchlist = useCallback((symbol) => {
    const sym = (symbol || watchInput).trim().toUpperCase();
    if (!sym) return;
    setWatchlists((w) => ({ ...w, [activeWatchlist]: [...new Set([...(w[activeWatchlist] || []), sym])] }));
    setWatchInput("");
  }, [watchInput, activeWatchlist]);

  const removeFromWatchlist = (sym) => {
    setWatchlists((w) => ({ ...w, [activeWatchlist]: (w[activeWatchlist] || []).filter((s) => s !== sym) }));
  };

  const requestNotifPerm = () => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }
  };

  const portSignals = signals.filter((s) => s.scope === "portfolio");
  const portfolioStocks = portfolio.filter((s) => !MACRO_SYMBOLS.has(s.name.toUpperCase()));
  const portfolioStockNews = news.filter((n) =>
    portfolioStocks.some((s) =>
      (n.stocks || []).some((st) => st.toUpperCase() === s.name.toUpperCase())
      || (n.headline || "").toUpperCase().includes(s.name.toUpperCase())
    )
  );
  const filteredNews = newsFilter === "All" ? news : news.filter((n) => n.cat === newsFilter);

  // ── TAB COMPONENTS ──
  const Dashboard = () => (
    <div style={{ padding: "0 14px 90px" }}>
      <HomeSuggestionBlock
        name="NIFTY"
        badge="Scalping"
        finalCall={finalCalls.NIFTY}
        priceData={prices.NIFTY}
        eaKey="NIFTY"
        eaState={eaState}
        onAskEA={askEA}
        C={C}
        S={S}
      />

      <HomeCommodityBlock
        name="GOLD"
        priceData={prices.GOLD}
        swingCall={finalCalls.GOLD_swing}
        longCall={finalCalls.GOLD_long}
        eaState={eaState}
        onAskEA={askEA}
        C={C}
        S={S}
      />

      <HomeCommodityBlock
        name="SILVER"
        priceData={prices.SILVER}
        swingCall={finalCalls.SILVER_swing}
        longCall={finalCalls.SILVER_long}
        eaState={eaState}
        onAskEA={askEA}
        C={C}
        S={S}
      />

      <div style={{ marginTop: 4, marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
          <Star size={14} color={C.yellow} />
          <span style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>Portfolio & Watchlist</span>
        </div>
        {homeStockSymbols.length === 0 ? (
          <div style={{ ...S.card, textAlign: "center", color: C.muted, padding: 16 }}>Add holdings or watchlist stocks to see suggestions here.</div>
        ) : (
          homeStockSymbols.map((sym) => (
            <WatchlistSuggestionRow
              key={sym}
              symbol={sym}
              quote={watchQuotes[sym]}
              suggestion={getWatchlistMarketSuggestion(sym, watchQuotes[sym])}
              C={C}
              S={S}
            />
          ))
        )}
      </div>
    </div>
  );

  const Charts = () => (
    <div style={{ padding: "0 14px 90px" }}>
      <InstrumentDropdown
        instrument={instrument}
        setInstrument={setInstrument}
        open={chartsDropOpen}
        setOpen={setChartsDropOpen}
        isUp={isUp}
        marketStatus={marketStatus}
        C={C}
      />
      <div style={{ display: "flex", gap: 4, marginBottom: 10, flexWrap: "wrap" }}>
        {["1m", "5m", "15m", "1h", "1d"].map((t) => (
          <button key={t} onClick={() => setTf(t)} style={{ padding: "6px 14px", borderRadius: 8, background: t === tf ? C.green : C.card, color: t === tf ? "#000" : C.muted, border: `1px solid ${C.border}`, fontSize: 12, cursor: "pointer", fontWeight: 700 }}>{t}</button>
        ))}
      </div>
      <div style={{ ...S.card }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>{instrument} · {tf}</div>
        <CandleChart candles={instCandles.slice(-45)} height={230} C={C} />
      </div>

      {sett.ind.bb && analysis && (
        <div style={{ ...S.card }}>
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
        <div style={{ ...S.card }}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>EMA Values</div>
          <div style={{ display: "flex", gap: 16 }}>
            {sett.ind.ema20 && <span style={{ color: C.muted, fontSize: 12 }}>EMA 20: <b style={{ color: C.blue }}>{fmt(analysis.ema20)}</b></span>}
            {sett.ind.ema50 && <span style={{ color: C.muted, fontSize: 12 }}>EMA 50: <b style={{ color: C.yellow }}>{fmt(analysis.ema50)}</b></span>}
          </div>
        </div>
      )}

      {sett.ind.rsi && analysis && (
        <div style={{ ...S.card }}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>RSI (14) — {analysis.rsi}</div>
          <ResponsiveContainer width="100%" height={80}>
            <AreaChart data={analysis.rsiHist} margin={{ top: 5, right: 0, left: -30, bottom: 0 }}>
              <YAxis domain={[0, 100]} tick={{ fill: C.muted, fontSize: 10 }} />
              <ReferenceLine y={70} stroke={C.red} strokeDasharray="3 3" />
              <ReferenceLine y={30} stroke={C.green} strokeDasharray="3 3" />
              <Area type="monotone" dataKey="rsi" stroke={C.yellow} fill={`${C.yellow}22`} dot={false} strokeWidth={1.5} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {sett.ind.vol && (
        <div style={{ ...S.card }}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Volume</div>
          <ResponsiveContainer width="100%" height={70}>
            <BarChart data={instCandles.slice(-20)} margin={{ top: 0, right: 0, left: -30, bottom: 0 }}>
              <Bar dataKey="vol" fill={C.blue} opacity={0.65} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {analysis && (
        <div style={{ ...S.card }}>
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
    </div>
  );

  const TradesTab = () => (
    <div style={{ padding: "0 14px 90px" }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {["today", "week", "month"].map((p) => (
          <button key={p} onClick={() => setTradePeriod(p)} style={{ flex: 1, padding: 8, borderRadius: 8, background: tradePeriod === p ? C.green : C.card, color: tradePeriod === p ? "#000" : C.muted, border: `1px solid ${C.border}`, fontSize: 12, fontWeight: 700, cursor: "pointer", textTransform: "capitalize" }}>{p}</button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
        {[
          { l: "P&L", v: `₹${fmt(totPnL, 0)}`, c: totPnL >= 0 ? C.green : C.red },
          { l: "Win Rate", v: `${winRate}%`, c: winRate >= 60 ? C.green : C.yellow },
          { l: "Trades", v: filteredTrades.length, c: C.blue },
        ].map((s) => (
          <div key={s.l} style={{ ...S.card, marginBottom: 0, padding: 10, textAlign: "center" }}>
            <div style={{ color: C.muted, fontSize: 9, textTransform: "uppercase", marginBottom: 4 }}>{s.l}</div>
            <div style={{ color: s.c, fontWeight: 900, fontSize: 17 }}>{s.v}</div>
          </div>
        ))}
      </div>

      <button onClick={() => setAddTrade(!addTrade)} style={{ width: "100%", padding: 12, borderRadius: 10, background: C.green, color: "#000", fontWeight: 800, border: "none", fontSize: 14, cursor: "pointer", marginBottom: 10 }}>+ Log Scalp Trade</button>

      {addTrade && (
        <div style={{ ...S.card, borderColor: `${C.green}55` }}>
          <div style={{ color: C.text, fontWeight: 700, marginBottom: 10 }}>New Trade</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
            <select value={newT.ins} onChange={(e) => setNewT((p) => ({ ...p, ins: e.target.value }))} style={{ padding: 9, borderRadius: 7, background: C.dim, color: C.text, border: `1px solid ${C.border}` }}>
              {Object.keys(INSTRUMENTS).map((k) => <option key={k}>{k}</option>)}
            </select>
            <select value={newT.type} onChange={(e) => setNewT((p) => ({ ...p, type: e.target.value }))} style={{ padding: 9, borderRadius: 7, background: C.dim, color: C.text, border: `1px solid ${C.border}` }}>
              <option>BUY</option><option>SELL</option>
            </select>
          </div>
          <input type="date" value={newT.date} onChange={(e) => setNewT((p) => ({ ...p, date: e.target.value }))} style={{ width: "100%", padding: 9, borderRadius: 7, background: C.dim, color: C.text, border: `1px solid ${C.border}`, marginBottom: 8, boxSizing: "border-box" }} />
          <input placeholder={`Entry (live: ${fmt(cp)})`} value={newT.entry} onChange={(e) => setNewT((p) => ({ ...p, entry: e.target.value }))} style={{ width: "100%", padding: 9, borderRadius: 7, background: C.dim, color: C.text, border: `1px solid ${C.border}`, marginBottom: 8, boxSizing: "border-box" }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={logTrade} style={{ flex: 1, padding: 10, background: C.green, color: "#000", fontWeight: 800, border: "none", borderRadius: 8, cursor: "pointer" }}>Log Trade</button>
            <button onClick={() => setAddTrade(false)} style={{ flex: 1, padding: 10, background: C.dim, color: C.muted, border: "none", borderRadius: 8, cursor: "pointer" }}>Cancel</button>
          </div>
        </div>
      )}

      {filteredTrades.map((t) => (
        <div key={t.id} style={{ ...S.card, borderColor: t.win ? `${C.green}35` : `${C.red}35` }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                <span style={{ background: t.type === "BUY" ? `${C.green}28` : `${C.red}28`, color: t.type === "BUY" ? C.green : C.red, fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 4 }}>{t.type}</span>
                <span style={{ color: C.text, fontWeight: 700 }}>{t.ins}</span>
                <span style={{ color: C.muted, fontSize: 11 }}>{t.date} {t.time}</span>
              </div>
              <div style={{ color: C.muted, fontSize: 11 }}>₹{fmt(t.entry)} → ₹{fmt(t.exit)} · ⏱ {t.dur}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ color: t.pnl >= 0 ? C.green : C.red, fontWeight: 900, fontSize: 16 }}>{t.pnl >= 0 ? "+" : ""}₹{fmt(t.pnl, 0)}</div>
              <div style={{ color: t.win ? C.green : C.red, fontSize: 10, fontWeight: 700 }}>{t.win ? "✓ WIN" : "✗ LOSS"}</div>
            </div>
          </div>
        </div>
      ))}
      {!filteredTrades.length && <div style={{ ...S.card, textAlign: "center", color: C.muted }}>No trades for this period</div>}
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

  const TABS = [
    { id: "dashboard", Icon: Home, label: "Home" },
    { id: "charts", Icon: BarChart2, label: "Charts" },
    { id: "portfolio", Icon: Briefcase, label: "Portfolio" },
    // { id: "trades", Icon: Activity, label: "Trades" }, // hidden — re-enable when trade logging needed
    { id: "news", Icon: Newspaper, label: "News" },
    { id: "watchlist", Icon: Star, label: "Watch" },
    { id: "settings", Icon: Settings, label: "Settings" },
  ];

  const CONTENT = { dashboard: Dashboard, charts: Charts, news: NewsTab, settings: SettingsTab };
  const ActiveTab = CONTENT[tab];

  return (
    <div style={{ background: C.bg, minHeight: "100dvh", width: "100%", maxWidth: "min(100%, 960px)", margin: "0 auto", position: "relative", fontFamily: "'SF Pro Display',-apple-system,sans-serif", paddingBottom: 72 }}>
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 50 }}>
        <div>
          <div style={{ color: C.green, fontWeight: 900, fontSize: 19 }}>⚡ ScalpAI</div>
          <div style={{ color: C.muted, fontSize: 10 }}>{marketStatus.label} · {marketStatus.detail}</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div title={liveError || ""} style={{ display: "flex", alignItems: "center", gap: 5, background: isLive ? `${C.green}18` : `${C.yellow}18`, border: `1px solid ${isLive ? C.green : C.yellow}45`, borderRadius: 7, padding: "4px 10px" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: isLive ? C.green : C.yellow }} />
            <span style={{ color: isLive ? C.green : C.yellow, fontSize: 11, fontWeight: 700 }}>{isLive ? "LIVE" : "DEMO"}</span>
          </div>
          <button onClick={() => setChatOpen(true)} style={{ background: `${C.blue}22`, border: `1px solid ${C.blue}55`, borderRadius: 8, padding: "6px 12px", color: C.blue, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
            <MessageCircle size={14} /><span style={{ fontSize: 11, fontWeight: 700 }}>AI</span>
          </button>
        </div>
      </div>

      <div style={{ padding: "12px 16px 4px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ color: C.text, fontWeight: 900, fontSize: 21 }}>{TABS.find((t) => t.id === tab)?.label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 5, color: C.muted, fontSize: 11 }}><RefreshCw size={11} /> {refresh}s</div>
      </div>

      <div style={{ paddingTop: 8 }}>
        {tab === "watchlist" ? (
          <WatchlistTab
            watchlists={watchlists}
            activeWatchlist={activeWatchlist}
            onActiveWatchlistChange={setActiveWatchlist}
            watchInput={watchInput}
            onWatchInputChange={setWatchInput}
            watchPrices={watchPrices}
            onAdd={addToWatchlist}
            onRemove={removeFromWatchlist}
            C={C}
            S={S}
          />
        ) : tab === "portfolio" ? (
          <PortfolioTab
            portfolioSubTab={portfolioSubTab}
            onPortfolioSubTabChange={setPortfolioSubTab}
            portfolio={portfolio}
            newStock={newStock}
            onNewStockChange={setNewStock}
            onAddStock={addPortfolioStock}
            onRemoveStock={removePortfolioStock}
            portVal={portVal}
            portPnL={portPnL}
            portCost={portCost}
            portfolioStocks={portfolioStocks}
            portSignals={portSignals}
            portfolioStockNews={portfolioStockNews}
            cp={cp}
            sett={sett}
            csvRef={csvRef}
            onCsvChange={handleCSV}
            onNewsSelect={setSelNews}
            C={C}
            S={S}
          />
        ) : (
          ActiveTab && <ActiveTab />
        )}
      </div>

      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, margin: "0 auto", width: "100%", maxWidth: "min(100%, 960px)", background: C.card, borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-around", padding: "8px 0 max(12px, env(safe-area-inset-bottom))", zIndex: 50 }}>
        {TABS.map(({ id, Icon, label }) => (
          <button key={id} onClick={() => setTab(id)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "4px 4px", background: "none", border: "none", cursor: "pointer", minWidth: 0 }}>
            <Icon size={20} color={tab === id ? C.green : C.muted} />
            <span style={{ fontSize: 8, color: tab === id ? C.green : C.muted, fontWeight: tab === id ? 800 : 400 }}>{label}</span>
          </button>
        ))}
      </div>

      {selNews && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", zIndex: 200, display: "flex", alignItems: "flex-end" }} onClick={() => setSelNews(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, borderRadius: "18px 18px 0 0", padding: 20, width: "100%", maxHeight: "72vh", overflowY: "auto" }}>
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
        <div style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", flexDirection: "column", background: C.bg }}>
          <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>⚡ AI Assistant</div>
              <div style={{ color: C.muted, fontSize: 10, marginBottom: 8 }}>Powered by Groq</div>
              <select
                value={chatModel}
                onChange={(e) => setChatModel(e.target.value)}
                style={{ width: "100%", maxWidth: 280, padding: "6px 10px", borderRadius: 8, background: C.dim, color: C.text, border: `1px solid ${C.border}`, fontSize: 12, outline: "none" }}
              >
                {GROQ_CHAT_MODELS.map((m) => (
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
          <div style={{ padding: "8px 16px 16px", background: C.card, borderTop: `1px solid ${C.border}`, display: "flex", gap: 8 }}>
            <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendMsg()} placeholder="Ask or control the app…" style={{ flex: 1, padding: 12, borderRadius: 12, background: C.dim, color: C.text, border: `1px solid ${C.border}`, fontSize: 14, outline: "none" }} />
            <button onClick={sendMsg} disabled={chatLoading} style={{ padding: 12, borderRadius: 12, background: chatLoading ? C.dim : C.green, border: "none", cursor: chatLoading ? "not-allowed" : "pointer" }}><Send size={18} color={chatLoading ? C.muted : "#000"} /></button>
          </div>
        </div>
      )}

      <style>{`
        html, body { margin: 0; padding: 0; min-height: 100%; overflow-x: hidden; overflow-y: auto; -webkit-overflow-scrolling: touch; background: ${C.bg}; }
        * { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; }
        input[type=range] { cursor: pointer; }
      `}</style>
    </div>
  );
}
