"use client";

import { fetchRealMarketData } from './lib/marketData';

import { useState, useEffect, useRef } from "react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  TrendingUp, TrendingDown, Settings, ChevronDown,
  MessageCircle, X, Send, Newspaper, BarChart2,
  Briefcase, Home, Activity, ArrowUp, ArrowDown,
  Zap, RefreshCw,
} from "lucide-react";

// ─────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────
const INSTRUMENTS = {
  "NIFTY":        { base: 25000, vol: 0.0012, lot: 50 },
  "SENSEX":       { base: 82000, vol: 0.0010, lot: 10 },
  "BANK NIFTY":   { base: 55000, vol: 0.0015, lot: 15 },
  "FINNIFTY":     { base: 23800, vol: 0.0013, lot: 40 },
  "MIDCAP NIFTY": { base: 12500, vol: 0.0018, lot: 75 },
};

const C = {
  bg: "#040810", card: "#070c18", border: "#131f35",
  green: "#00e676", red: "#ff1744", yellow: "#ffab00",
  blue: "#2979ff", text: "#dde6f0", muted: "#4e6278", dim: "#0e1828",
};

const S = { card: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 10 } };

// ─────────────────────────────────────────
// DATA GENERATORS
// ─────────────────────────────────────────
function genCandles(base, count = 65, vol = 0.0014) {
  const out = []; let p = base; const now = Date.now();
  for (let i = count; i >= 0; i--) {
    const d = ((Math.random() > 0.47 ? 1 : -1) * Math.random() * vol * p);
    const o = p, c = p + d;
    const h = Math.max(o, c) + Math.random() * 0.35 * vol * p;
    const l = Math.min(o, c) - Math.random() * 0.35 * vol * p;
    out.push({ t: new Date(now - i * 5 * 60000).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }), o: +o.toFixed(2), h: +h.toFixed(2), l: +l.toFixed(2), c: +c.toFixed(2), vol: Math.floor(80000 + Math.random() * 400000) });
    p = c;
  }
  return out;
}

function genRSIHistory(n = 30) {
  const out = []; let r = 50;
  for (let i = 0; i < n; i++) {
    r = Math.max(18, Math.min(82, r + (Math.random() - 0.5) * 4));
    out.push({ i, rsi: +r.toFixed(1) });
  }
  return out;
}

const SIGNALS = [
  { type: "BUY",  str: "STRONG",   reason: "RSI oversold (26) + MACD bullish crossover + price at key support", prob: 74 },
  { type: "BUY",  str: "MODERATE", reason: "Price broke above 20 EMA + volume spike + stochastic turning up",   prob: 63 },
  { type: "SELL", str: "STRONG",   reason: "RSI overbought (77) + bearish engulfing candle + resistance hit",   prob: 71 },
  { type: "SELL", str: "MODERATE", reason: "MACD bearish cross + price below 50 EMA + declining volume",        prob: 60 },
  { type: "BUY",  str: "WEAK",     reason: "Support hold + minor volume pickup + RSI recovering from oversold", prob: 54 },
];

const NEWS = [
  { id:1, headline:"RBI keeps repo rate at 6.5%, hints at liquidity easing ahead", impact:"HIGH", time:"1h ago", cat:"Market",    sentiment:"neutral",  stocks:["HDFCBANK","ICICIBANK","SBIN"],        detail:"MPC voted unanimously to hold. Governor hinted liquidity support ahead of fiscal year-end, potentially benefiting banking stocks short-term." },
  { id:2, headline:"FII buys ₹8,400 Cr in equities today — biggest inflow this month", impact:"HIGH", time:"2h ago", cat:"Market",    sentiment:"positive", stocks:["NIFTY","SENSEX"],                     detail:"FIIs made their largest single-day purchase this month, primarily in banking and infra. Signals renewed confidence in Indian equities." },
  { id:3, headline:"TCS Q3 revenue up 4.5% YoY — misses 5.8% estimate, guidance cautious", impact:"HIGH", time:"3h ago", cat:"Earnings",  sentiment:"negative", stocks:["TCS","INFY","WIPRO"],                 detail:"TCS cited client budget freezes in North America. Management held full-year guidance but analysts are cutting FY25 estimates." },
  { id:4, headline:"BANK NIFTY surges 1.2% on strong credit-growth data; PSU banks lead", impact:"MEDIUM",time:"30m ago",cat:"Sector",    sentiment:"positive", stocks:["SBIN","PNB","BANK NIFTY"],            detail:"September credit growth hit 16.2%, beating estimates of 14.8%. PSU banks top beneficiaries as retail lending surged." },
  { id:5, headline:"Reliance Industries up 2.1% on ₹40,000 Cr Green Energy JV with BP", impact:"HIGH", time:"4h ago", cat:"Corporate",  sentiment:"positive", stocks:["RELIANCE"],                           detail:"Asia's largest green hydrogen JV announced. Analysts see this as a 10-year growth catalyst for RIL." },
  { id:6, headline:"NIFTY 50 breaks 25,200 resistance; technicals target 25,500 next", impact:"MEDIUM",time:"45m ago",cat:"Technical",  sentiment:"positive", stocks:["NIFTY"],                              detail:"NIFTY closed above 200-day EMA on strong volume. Next resistance 25,500; immediate support shifts to 25,100." },
  { id:7, headline:"Crude up 2.4% on OPEC+ cut extension — mixed picture for India", impact:"MEDIUM",time:"5h ago", cat:"Global",    sentiment:"negative", stocks:["RELIANCE","ONGC","BPCL"],             detail:"Brent crude crosses $90/bbl. Upstream companies gain; downstream retailers and aviation stocks face margin pressure." },
  { id:8, headline:"Auto retail sales surge 18% in December — Maruti & Tata Motors shine", impact:"MEDIUM",time:"6h ago", cat:"Sector",    sentiment:"positive", stocks:["MARUTI","TATAMOTORS","M&M"],          detail:"FADA data shows 18% YoY growth led by SUVs (+28%) and festive hangover demand." },
];

// ─────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────
const fmt  = (n, d = 2) => n?.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }) ?? "—";
const fmtD = (n) => (n >= 0 ? "+" : "") + fmt(n);

// ─────────────────────────────────────────
// CANDLESTICK SVG
// ─────────────────────────────────────────
function CandleChart({ candles = [], height = 200 }) {
  if (!candles.length) return null;
  const W = 800, PAD = 10, H = height, ch = H - PAD * 2;
  const maxP = Math.max(...candles.map(c => c.h));
  const minP = Math.min(...candles.map(c => c.l));
  const range = maxP - minP || 1;
  const toY = p => PAD + ((maxP - p) / range) * ch;
  const sw = W / candles.length;
  const bw = Math.max(2, sw * 0.6);
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block" }}>
      {[0.25, 0.5, 0.75].map(f => (
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

// ─────────────────────────────────────────
// SIGNAL CARD
// ─────────────────────────────────────────
function SignalCard({ sig, price }) {
  const buy = sig.type === "BUY";
  const target = +(price * (buy ? 1.009 : 0.991)).toFixed(2);
  const sl     = +(price * (buy ? 0.994 : 1.006)).toFixed(2);
  const rr     = (Math.abs(target - price) / Math.abs(price - sl)).toFixed(1);
  const clr    = buy ? C.green : C.red;
  return (
    <div style={{ background: `${clr}0d`, border: `1px solid ${clr}45`, borderRadius: 12, padding: 13, marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ background: clr, color: "#000", fontWeight: 800, fontSize: 10, padding: "2px 9px", borderRadius: 4, letterSpacing: 0.5 }}>{sig.type}</span>
          <span style={{ color: C.muted, fontSize: 11, fontWeight: 600 }}>{sig.str}</span>
        </div>
        <span style={{ color: clr, fontWeight: 800, fontSize: 13 }}>{sig.prob}% confidence</span>
      </div>
      <p style={{ color: C.text, fontSize: 12, lineHeight: 1.45, margin: "0 0 9px" }}>{sig.reason}</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 5 }}>
        {[
          { l: "Entry",    v: fmt(price),  c: C.blue   },
          { l: "Target",   v: fmt(target), c: C.green  },
          { l: "Stop Loss",v: fmt(sl),     c: C.red    },
          { l: "R:R",      v: `1:${rr}`,   c: C.yellow },
        ].map(x => (
          <div key={x.l} style={{ background: C.dim, borderRadius: 6, padding: "6px 3px", textAlign: "center" }}>
            <div style={{ color: C.muted, fontSize: 9, marginBottom: 2, textTransform: "uppercase", letterSpacing: 0.4 }}>{x.l}</div>
            <div style={{ color: x.c, fontWeight: 800, fontSize: 11 }}>{x.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────
// NEWS CARD
// ─────────────────────────────────────────
function NewsCard({ n, onClick }) {
  const sc = n.sentiment === "positive" ? C.green : n.sentiment === "negative" ? C.red : C.yellow;
  const ic = n.impact === "HIGH" ? C.red : n.impact === "MEDIUM" ? C.yellow : C.muted;
  return (
    <div onClick={() => onClick(n)} style={{ ...S.card, cursor: "pointer", padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ background: `${sc}22`, color: sc, fontSize: 10, padding: "2px 7px", borderRadius: 4, fontWeight: 700 }}>{n.cat}</span>
        <div style={{ display: "flex", gap: 8 }}>
          <span style={{ color: ic, fontSize: 10, fontWeight: 700 }}>⚡{n.impact}</span>
          <span style={{ color: C.muted, fontSize: 10 }}>{n.time}</span>
        </div>
      </div>
      <p style={{ color: C.text, fontSize: 13, lineHeight: 1.45, margin: "0 0 8px" }}>{n.headline}</p>
      <div style={{ display: "flex", gap: 4 }}>
        {n.stocks.slice(0, 3).map(s => <span key={s} style={{ background: C.dim, color: C.muted, fontSize: 10, padding: "2px 6px", borderRadius: 4 }}>{s}</span>)}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────
// TOGGLE SWITCH
// ─────────────────────────────────────────
function Toggle({ on, onToggle }) {
  return (
    <button onClick={onToggle} style={{ width: 46, height: 26, borderRadius: 13, background: on ? C.green : C.dim, border: "none", cursor: "pointer", position: "relative", transition: "background .2s", flexShrink: 0 }}>
      <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: on ? 23 : 3, transition: "left .2s", boxShadow: "0 1px 4px rgba(0,0,0,.4)" }} />
    </button>
  );
}

// ─────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────
export default function App() {
  // ── Core state ──────────────────────────
  const [instrument, setInstrument] = useState("NIFTY");
  const [dropOpen,   setDropOpen]   = useState(false);
  const [tab,        setTab]        = useState("dashboard");
  const [tf,         setTf]         = useState("5m");
  const [refresh,    setRefresh]    = useState(5);

  // ── Market data ──────────────────────────
  const initPrices = () => {
    const p = {};
    Object.entries(INSTRUMENTS).forEach(([k, v]) => {
      const prev = +(v.base * (1 + (Math.random() - 0.5) * 0.006)).toFixed(2);
      p[k] = { cur: v.base, open: +(v.base * 0.999).toFixed(2), high: +(v.base * 1.007).toFixed(2), low: +(v.base * 0.993).toFixed(2), prev };
    });
    return p;
  };
  const [prices,     setPrices]     = useState(initPrices);
  const [candles,    setCandles]    = useState(() => { const c = {}; Object.entries(INSTRUMENTS).forEach(([k, v]) => { c[k] = genCandles(v.base, 65, v.vol); }); return c; });
  const [rsiHist,    setRsiHist]    = useState(genRSIHistory(30));
  const [rsi,        setRsi]        = useState(52);
  const [macd,       setMacd]       = useState({ v: 0.35, s: 0.12, h: 0.23 });
  const [signals,    setSignals]    = useState([]);

  // ── Portfolio ────────────────────────────
  const [portfolio, setPortfolio] = useState([
    { id: 1, name: "RELIANCE",  qty: 10, buy: 2850, cur: 2920, sector: "Energy"  },
    { id: 2, name: "TCS",       qty: 5,  buy: 3980, cur: 3856, sector: "IT"      },
    { id: 3, name: "HDFCBANK",  qty: 20, buy: 1680, cur: 1720, sector: "Banking" },
    { id: 4, name: "INFY",      qty: 15, buy: 1820, cur: 1795, sector: "IT"      },
    { id: 5, name: "ICICIBANK", qty: 25, buy: 1145, cur: 1180, sector: "Banking" },
  ]);

  // ── Trades ───────────────────────────────
  const [trades, setTrades] = useState([
    { id: 1, ins: "NIFTY",      type: "BUY",  entry: 25120, exit: 25250, qty: 1, time: "09:35", dur: "8m",  pnl: 6500,  win: true  },
    { id: 2, ins: "BANK NIFTY", type: "SELL", entry: 55200, exit: 55310, qty: 1, time: "10:15", dur: "5m",  pnl: -1650, win: false },
    { id: 3, ins: "NIFTY",      type: "BUY",  entry: 25180, exit: 25295, qty: 1, time: "11:02", dur: "12m", pnl: 5750,  win: true  },
  ]);
  const [addTrade, setAddTrade] = useState(false);
  const [newT, setNewT] = useState({ ins: "NIFTY", type: "BUY", entry: "", qty: 1 });

  // ── News ─────────────────────────────────
  const [selNews,    setSelNews]    = useState(null);
  const [newsFilter, setNewsFilter] = useState("All");

  // ── Settings ─────────────────────────────
  const [sett, setSett] = useState({
    riskLimit: 10000, profitPct: 1.5, slPct: 0.8,
    ind: { rsi: true, macd: true, bb: true, ema20: true, ema50: true, vol: true },
  });

  // ── Chat ─────────────────────────────────
  const [chatOpen, setChatOpen] = useState(false);
  const [msgs, setMsgs] = useState([
    { role: "assistant", content: "👋 Hi! I'm your AI scalping assistant.\n\nI can:\n• Analyze NIFTY / SENSEX / BANK NIFTY\n• Switch instruments & modify app settings live\n• Add stocks to your portfolio\n• Answer any trading question\n\nTry: \"Switch to BANK NIFTY\", \"What does RSI say?\", or \"Disable volume indicator\"." }
  ]);
  const [chatInput,   setChatInput]   = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEnd = useRef(null);

  // ─────────────────────────────────────────
  // EFFECTS
  // ─────────────────────────────────────────
  // Fetch real market data on mount
  useEffect(() => {
    const fetchData = async () => {
      for (const inst of Object.keys(INSTRUMENTS)) {
        const realData = await fetchRealMarketData(inst);
        if (realData && realData.source === 'finnhub') {
          setPrices(prev => ({
            ...prev,
            [inst]: {
              cur: realData.cur,
              open: realData.open,
              high: realData.high,
              low: realData.low,
              prev: realData.prev,
            }
          }));
        }
      }
    };
    fetchData();
  }, []);
  useEffect(() => {
    const id = setInterval(() => {
      setPrices(prev => {
        const next = { ...prev };
        Object.entries(INSTRUMENTS).forEach(([k, v]) => {
          const d = (Math.random() - 0.48) * v.vol * prev[k].cur;
          const cur = +(prev[k].cur + d).toFixed(2);
          next[k] = { ...prev[k], cur, high: Math.max(prev[k].high, cur), low: Math.min(prev[k].low, cur) };
        });
        return next;
      });
      setRsi(p => +Math.max(18, Math.min(82, p + (Math.random() - 0.5) * 1.6)).toFixed(1));
      setMacd(p => {
        const v = +(p.v + (Math.random() - 0.5) * 0.07).toFixed(3);
        const s = +(p.s + (Math.random() - 0.5) * 0.04).toFixed(3);
        return { v, s, h: +(v - s).toFixed(3) };
      });
      setRsiHist(p => {
        const r = +Math.max(18, Math.min(82, p[p.length - 1].rsi + (Math.random() - 0.5) * 3)).toFixed(1);
        return [...p.slice(1), { i: p[p.length - 1].i + 1, rsi: r }];
      });
    }, refresh * 1000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const id = setInterval(() => setPortfolio(p => p.map(s => ({ ...s, cur: +(s.cur * (1 + (Math.random() - 0.5) * 0.0008)).toFixed(2) }))), 8000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const pick = () => setSignals([...SIGNALS].sort(() => Math.random() - 0.5).slice(0, Math.floor(Math.random() * 2) + 1));
    pick();
    const id = setInterval(pick, 30000);
    return () => clearInterval(id);
  }, [instrument]);

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  // ─────────────────────────────────────────
  // DERIVED VALUES
  // ─────────────────────────────────────────
  const P       = prices[instrument];
  const cp      = P?.cur ?? 0;
  const chg     = +(cp - (P?.prev ?? cp)).toFixed(2);
  const pct     = +((chg / (P?.prev ?? cp)) * 100).toFixed(2);
  const isUp    = chg >= 0;
  const totPnL  = trades.reduce((s, t) => s + t.pnl, 0);
  const winRate = trades.length ? Math.round(trades.filter(t => t.win).length / trades.length * 100) : 0;
  const portPnL = portfolio.reduce((s, p) => s + (p.cur - p.buy) * p.qty, 0);
  const portVal = portfolio.reduce((s, p) => s + p.cur * p.qty, 0);
  const portCost= portfolio.reduce((s, p) => s + p.buy * p.qty, 0);

  // ─────────────────────────────────────────
  // APP COMMAND EXECUTOR (AI chat)
  // ─────────────────────────────────────────
  const execCmd = (json) => {
    try {
      const { action, value } = JSON.parse(json);
      if (action === "changeInstrument" && INSTRUMENTS[value]) setInstrument(value);
      if (action === "changeTimeframe")  setTf(value);
      if (action === "changeRefreshRate") setRefresh(+value);
      if (action === "toggleIndicator")  setSett(p => ({ ...p, ind: { ...p.ind, [value]: !p.ind[value] } }));
      if (action === "setRiskLimit")     setSett(p => ({ ...p, riskLimit: +value }));
      if (action === "addStock")         setPortfolio(p => [...p, { id: Date.now(), name: value.name, qty: +value.qty, buy: +value.price, cur: +value.price, sector: value.sector || "Other" }]);
      if (action === "switchTab")        setTab(value);
    } catch (_) {}
  };

  // ─────────────────────────────────────────
  // AI CHAT
  // ─────────────────────────────────────────
  const sendMsg = async () => {
    if (!chatInput.trim() || chatLoading) return;
    const text = chatInput.trim();
    setChatInput("");
    setMsgs(p => [...p, { role: "user", content: text }]);
    setChatLoading(true);
    try {
      const sys = `You are an AI scalping assistant embedded in a mobile trading dashboard for Indian markets.

CURRENT STATE:
- Instrument: ${instrument} @ ₹${fmt(cp)} (${chg >= 0 ? "+" : ""}${chg}, ${pct}%)
- Timeframe: ${tf} | Refresh: ${refresh}s
- RSI: ${rsi} | MACD Histogram: ${macd.h}
- Today P&L: ₹${totPnL} | Win Rate: ${winRate}%
- Portfolio: ${portfolio.map(s => `${s.name}(${s.qty}@₹${s.buy})`).join(", ")}
- Active Signals: ${signals.map(s => s.type).join(", ") || "none"}

You can MODIFY the app by adding this at the END of your message:
<CMD>{"action":"commandName","value":"commandValue"}</CMD>

Commands available:
- changeInstrument  → "NIFTY" | "SENSEX" | "BANK NIFTY" | "FINNIFTY" | "MIDCAP NIFTY"
- changeTimeframe   → "1m"|"5m"|"15m"|"1h"|"1d"
- changeRefreshRate → number (3–60)
- toggleIndicator   → "rsi"|"macd"|"bb"|"ema20"|"ema50"|"vol"
- setRiskLimit      → number
- addStock          → {"name":"SYM","qty":10,"price":1000,"sector":"IT"}
- switchTab         → "dashboard"|"charts"|"portfolio"|"trades"|"news"|"settings"

Be concise, specific, and actionable. Confirm any change you make.`;

      const res  = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: sys,
          messages: [...msgs.slice(-8), { role: "user", content: text }],
        }),
      });
      const data  = await res.json();
      const full  = data.content?.[0]?.text ?? "Sorry, try again.";
      const match = full.match(/<CMD>(.*?)<\/CMD>/s);
      if (match) execCmd(match[1].trim());
      setMsgs(p => [...p, { role: "assistant", content: full.replace(/<CMD>.*?<\/CMD>/gs, "").trim() }]);
    } catch {
      setMsgs(p => [...p, { role: "assistant", content: "⚠️ Connection error. Please try again." }]);
    } finally {
      setChatLoading(false);
    }
  };

  // ─────────────────────────────────────────
  // LOG TRADE
  // ─────────────────────────────────────────
  const logTrade = () => {
    if (!newT.entry) return;
    const lot  = INSTRUMENTS[newT.ins].lot;
    const exit = +(+newT.entry * (newT.type === "BUY" ? 1.0045 : 0.9955)).toFixed(2);
    const pnl  = +((exit - +newT.entry) * (newT.type === "BUY" ? 1 : -1) * +newT.qty * lot).toFixed(0);
    setTrades(p => [{
      id: Date.now(), ins: newT.ins, type: newT.type,
      entry: +newT.entry, exit, qty: +newT.qty,
      time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
      dur: "Active", pnl, win: pnl > 0,
    }, ...p]);
    setAddTrade(false);
    setNewT({ ins: "NIFTY", type: "BUY", entry: "", qty: 1 });
  };

  // ─────────────────────────────────────────
  // TAB: DASHBOARD
  // ─────────────────────────────────────────
  const Dashboard = () => (
    <div style={{ padding: "0 14px 90px" }}>
      {/* Instrument Dropdown */}
      <div style={{ position: "relative", marginBottom: 12 }}>
        <button onClick={() => setDropOpen(!dropOpen)} style={{ display: "flex", alignItems: "center", gap: 8, background: C.card, border: `1px solid ${isUp ? C.green + "60" : C.red + "60"}`, borderRadius: 10, padding: "10px 14px", color: C.text, fontSize: 15, fontWeight: 800, cursor: "pointer", width: "100%", letterSpacing: -.3 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.green, display: "inline-block", boxShadow: `0 0 6px ${C.green}` }} />
          {instrument}
          <ChevronDown size={15} style={{ marginLeft: "auto", color: C.muted }} />
        </button>
        {dropOpen && (
          <div style={{ position: "absolute", top: "105%", left: 0, right: 0, background: "#0b1020", border: `1px solid ${C.border}`, borderRadius: 10, zIndex: 100, overflow: "hidden" }}>
            {Object.keys(INSTRUMENTS).map(k => (
              <button key={k} onClick={() => { setInstrument(k); setDropOpen(false); }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", padding: "12px 16px", background: k === instrument ? `${C.green}18` : "transparent", color: k === instrument ? C.green : C.text, textAlign: "left", border: "none", cursor: "pointer", fontSize: 14, fontWeight: k === instrument ? 800 : 400, borderBottom: `1px solid ${C.border}` }}>
                {k} {k === instrument && <span style={{ fontSize: 10 }}>● ACTIVE</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Price Hero */}
      <div style={{ background: `linear-gradient(135deg,${C.card} 0%,#0c1828 100%)`, border: `1px solid ${isUp ? C.green + "40" : C.red + "40"}`, borderRadius: 14, padding: 16, marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ color: C.muted, fontSize: 10, marginBottom: 4, letterSpacing: 1, textTransform: "uppercase" }}>{instrument} · LIVE</div>
            <div style={{ color: C.text, fontSize: 31, fontWeight: 900, letterSpacing: -1, fontVariantNumeric: "tabular-nums" }}>₹{fmt(cp)}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 5 }}>
              {isUp ? <ArrowUp size={13} color={C.green} /> : <ArrowDown size={13} color={C.red} />}
              <span style={{ color: isUp ? C.green : C.red, fontWeight: 700, fontSize: 14 }}>{fmtD(chg)} ({pct >= 0 ? "+" : ""}{pct}%)</span>
            </div>
          </div>
          <div style={{ textAlign: "right", background: C.dim, borderRadius: 8, padding: "8px 12px" }}>
            <div style={{ color: C.muted, fontSize: 10 }}>H <span style={{ color: C.green }}>{fmt(P?.high)}</span></div>
            <div style={{ color: C.muted, fontSize: 10 }}>L <span style={{ color: C.red }}>{fmt(P?.low)}</span></div>
            <div style={{ color: C.muted, fontSize: 10 }}>O <span style={{ color: C.text }}>{fmt(P?.open)}</span></div>
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
        {[
          { l: "Today's P&L",  v: `₹${fmt(totPnL,0)}`,   c: totPnL  >= 0 ? C.green : C.red    },
          { l: "Win Rate",     v: `${winRate}%`,           c: winRate >= 60 ? C.green : C.yellow },
          { l: "Trades Today", v: trades.length,           c: C.blue                             },
          { l: "Portfolio P&L",v: `₹${fmt(portPnL,0)}`,   c: portPnL >= 0 ? C.green : C.red    },
        ].map(s => (
          <div key={s.l} style={{ ...S.card, marginBottom: 0, padding: 12 }}>
            <div style={{ color: C.muted, fontSize: 10, marginBottom: 4, textTransform: "uppercase", letterSpacing: .4 }}>{s.l}</div>
            <div style={{ color: s.c, fontWeight: 900, fontSize: 20, fontVariantNumeric: "tabular-nums" }}>{s.v}</div>
          </div>
        ))}
      </div>

      {/* Mini Chart */}
      <div style={{ ...S.card }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ color: C.text, fontWeight: 700, fontSize: 13 }}>{instrument} · {tf}</span>
          <div style={{ display: "flex", gap: 3 }}>
            {["1m","5m","15m","1h"].map(t => (
              <button key={t} onClick={() => setTf(t)} style={{ padding: "3px 8px", borderRadius: 5, background: t === tf ? C.green : C.dim, color: t === tf ? "#000" : C.muted, border: "none", fontSize: 10, cursor: "pointer", fontWeight: 700 }}>{t}</button>
            ))}
          </div>
        </div>
        <CandleChart candles={candles[instrument]?.slice(-35) ?? []} height={165} />
      </div>

      {/* RSI */}
      {sett.ind.rsi && (
        <div style={{ ...S.card }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ color: C.muted, fontSize: 12 }}>RSI (14)</span>
            <span style={{ color: rsi > 70 ? C.red : rsi < 30 ? C.green : C.yellow, fontWeight: 700, fontSize: 13 }}>
              {rsi} · {rsi > 70 ? "⚠ Overbought" : rsi < 30 ? "✅ Oversold" : "Neutral"}
            </span>
          </div>
          <div style={{ background: C.dim, borderRadius: 4, height: 6, marginBottom: 4 }}>
            <div style={{ width: `${rsi}%`, height: "100%", background: rsi > 70 ? C.red : rsi < 30 ? C.green : C.yellow, borderRadius: 4, transition: "width 1s ease" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", color: C.muted, fontSize: 9 }}>
            <span>0 — Oversold</span><span>50</span><span>Overbought — 100</span>
          </div>
        </div>
      )}

      {/* MACD */}
      {sett.ind.macd && (
        <div style={{ ...S.card }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
            <span style={{ color: C.muted, fontSize: 12 }}>MACD</span>
            <span style={{ color: macd.h > 0 ? C.green : C.red, fontWeight: 700, fontSize: 13 }}>{macd.h > 0 ? "▲ Bullish" : "▼ Bearish"}</span>
          </div>
          <div style={{ display: "flex", gap: 14 }}>
            <span style={{ color: C.muted, fontSize: 11 }}>MACD <span style={{ color: C.blue,   fontWeight: 700 }}>{macd.v.toFixed(2)}</span></span>
            <span style={{ color: C.muted, fontSize: 11 }}>Signal <span style={{ color: C.yellow, fontWeight: 700 }}>{macd.s.toFixed(2)}</span></span>
            <span style={{ color: C.muted, fontSize: 11 }}>Hist <span style={{ color: macd.h > 0 ? C.green : C.red, fontWeight: 700 }}>{macd.h.toFixed(2)}</span></span>
          </div>
        </div>
      )}

      {/* Signals */}
      <div style={{ marginTop: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <Zap size={14} color={C.yellow} />
          <span style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>Active Scalping Signals</span>
        </div>
        {signals.length
          ? signals.map((s, i) => <SignalCard key={i} sig={s} price={cp} />)
          : <div style={{ ...S.card, textAlign: "center", color: C.muted, fontSize: 13, padding: 20 }}>Scanning for signals…</div>}
      </div>
    </div>
  );

  // ─────────────────────────────────────────
  // TAB: CHARTS
  // ─────────────────────────────────────────
  const Charts = () => (
    <div style={{ padding: "0 14px 90px" }}>
      <div style={{ display: "flex", gap: 4, marginBottom: 10, flexWrap: "wrap" }}>
        {["1m","5m","15m","1h","1d"].map(t => (
          <button key={t} onClick={() => setTf(t)} style={{ padding: "6px 14px", borderRadius: 8, background: t === tf ? C.green : C.card, color: t === tf ? "#000" : C.muted, border: `1px solid ${C.border}`, fontSize: 12, cursor: "pointer", fontWeight: 700 }}>{t}</button>
        ))}
      </div>

      <div style={{ ...S.card }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>{instrument} Candlestick · {tf}</div>
        <CandleChart candles={candles[instrument]?.slice(-45) ?? []} height={230} />
      </div>

      {sett.ind.rsi && (
        <div style={{ ...S.card }}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>RSI (14) — {rsi}</div>
          <ResponsiveContainer width="100%" height={80}>
            <AreaChart data={rsiHist} margin={{ top:5, right:0, left:-30, bottom:0 }}>
              <YAxis domain={[0,100]} />
              <ReferenceLine y={70} stroke={C.red}   strokeDasharray="3 3" strokeWidth={1} />
              <ReferenceLine y={30} stroke={C.green} strokeDasharray="3 3" strokeWidth={1} />
              <Area type="monotone" dataKey="rsi" stroke={C.yellow} fill={`${C.yellow}22`} dot={false} strokeWidth={1.5} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {sett.ind.vol && (
        <div style={{ ...S.card }}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Volume</div>
          <ResponsiveContainer width="100%" height={70}>
            <BarChart data={candles[instrument]?.slice(-20) ?? []} margin={{ top:0, right:0, left:-30, bottom:0 }}>
              <Bar dataKey="vol" fill={C.blue} opacity={0.65} radius={[2,2,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div style={{ ...S.card }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Technical Summary</div>
        {[
          { n:"RSI (14)",        v:rsi.toFixed(1), sig: rsi>70?"Overbought":rsi<30?"Oversold":"Neutral",              t:rsi>70?"SELL":rsi<30?"BUY":"HOLD" },
          { n:"MACD",            v:macd.h.toFixed(2), sig:macd.h>0?"Bullish Crossover":"Bearish Crossover",           t:macd.h>0?"BUY":"SELL" },
          { n:"EMA 20/50",       v:"Aligned",   sig:"Price above both EMAs",                                          t:"BUY" },
          { n:"Bollinger Bands", v:"Mid-band",  sig:"Neutral consolidation zone",                                      t:"HOLD" },
          { n:"Stochastic",      v:"58",        sig:"Neutral momentum",                                                t:"HOLD" },
          { n:"ATR",             v:fmt(cp*0.008), sig:"Normal intraday volatility",                                    t:"HOLD" },
        ].map(row => (
          <div key={row.n} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.dim}` }}>
            <div>
              <div style={{ color: C.text, fontSize: 12, fontWeight: 600 }}>{row.n}</div>
              <div style={{ color: C.muted, fontSize: 10 }}>{row.sig}</div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ color: C.muted, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{row.v}</span>
              <span style={{ background: row.t==="BUY"?`${C.green}22`:row.t==="SELL"?`${C.red}22`:`${C.muted}22`, color: row.t==="BUY"?C.green:row.t==="SELL"?C.red:C.muted, padding:"2px 9px", borderRadius:4, fontSize:10, fontWeight:800, letterSpacing:.5 }}>{row.t}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // ─────────────────────────────────────────
  // TAB: PORTFOLIO
  // ─────────────────────────────────────────
  const Portfolio = () => {
    const retPct = +((portPnL / portCost) * 100).toFixed(2);
    return (
      <div style={{ padding: "0 14px 90px" }}>
        <div style={{ ...S.card, background: `linear-gradient(135deg,${C.card},#0c1828)` }}>
          <div style={{ color: C.muted, fontSize: 10, marginBottom: 4, textTransform: "uppercase", letterSpacing: .5 }}>Total Portfolio Value</div>
          <div style={{ color: C.text, fontSize: 27, fontWeight: 900, fontVariantNumeric: "tabular-nums" }}>₹{fmt(portVal,0)}</div>
          <div style={{ color: portPnL >= 0 ? C.green : C.red, fontSize: 14, fontWeight: 700, marginTop: 4 }}>
            {portPnL >= 0 ? "+" : ""}₹{fmt(portPnL,0)} ({retPct >= 0 ? "+" : ""}{retPct}%)
          </div>
        </div>

        {portfolio.map(s => {
          const pnl    = (s.cur - s.buy) * s.qty;
          const pnlPct = +((s.cur - s.buy) / s.buy * 100).toFixed(2);
          const up     = pnl >= 0;
          return (
            <div key={s.id} style={{ ...S.card, borderColor: up ? `${C.green}35` : `${C.red}35` }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div>
                  <div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>{s.name}</div>
                  <div style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>{s.sector} · {s.qty} shares</div>
                  <div style={{ color: C.muted, fontSize: 11 }}>Avg ₹{fmt(s.buy)}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ color: C.text, fontWeight: 800, fontSize: 15, fontVariantNumeric: "tabular-nums" }}>₹{fmt(s.cur)}</div>
                  <div style={{ color: up ? C.green : C.red, fontSize: 12, fontWeight: 700 }}>{up?"+":""}₹{fmt(pnl,0)} ({pnlPct>=0?"+":""}{pnlPct}%)</div>
                  <div style={{ marginTop: 4, background: up?`${C.green}20`:`${C.red}20`, color: up?C.green:C.red, fontSize: 9, fontWeight: 800, padding: "2px 7px", borderRadius: 3, letterSpacing: .4 }}>
                    {up ? "HOLD / ACCUMULATE" : "MONITOR / REVIEW"}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        <button onClick={() => setChatOpen(true)} style={{ width: "100%", padding: 14, borderRadius: 12, background: `${C.green}15`, border: `1px dashed ${C.green}65`, color: C.green, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
          + Upload Portfolio or Add Stock via AI Chat
        </button>
      </div>
    );
  };

  // ─────────────────────────────────────────
  // TAB: TRADES
  // ─────────────────────────────────────────
  const Trades = () => (
    <div style={{ padding: "0 14px 90px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
        {[
          { l:"Total P&L", v:`₹${fmt(totPnL,0)}`, c:totPnL>=0?C.green:C.red    },
          { l:"Win Rate",  v:`${winRate}%`,        c:winRate>=60?C.green:C.yellow },
          { l:"Trades",    v:trades.length,         c:C.blue                     },
        ].map(s => (
          <div key={s.l} style={{ ...S.card, marginBottom: 0, padding: 10, textAlign: "center" }}>
            <div style={{ color: C.muted, fontSize: 9, textTransform: "uppercase", letterSpacing: .4, marginBottom: 4 }}>{s.l}</div>
            <div style={{ color: s.c, fontWeight: 900, fontSize: 17 }}>{s.v}</div>
          </div>
        ))}
      </div>

      <button onClick={() => setAddTrade(!addTrade)} style={{ width: "100%", padding: 12, borderRadius: 10, background: C.green, color: "#000", fontWeight: 800, border: "none", fontSize: 14, cursor: "pointer", marginBottom: 10 }}>
        + Log New Scalp Trade
      </button>

      {addTrade && (
        <div style={{ ...S.card, borderColor: `${C.green}55` }}>
          <div style={{ color: C.text, fontWeight: 700, marginBottom: 10, fontSize: 13 }}>New Trade Entry</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
            <select value={newT.ins} onChange={e => setNewT(p => ({ ...p, ins: e.target.value }))} style={{ padding: 9, borderRadius: 7, background: C.dim, color: C.text, border: `1px solid ${C.border}`, fontSize: 13 }}>
              {Object.keys(INSTRUMENTS).map(k => <option key={k}>{k}</option>)}
            </select>
            <select value={newT.type} onChange={e => setNewT(p => ({ ...p, type: e.target.value }))} style={{ padding: 9, borderRadius: 7, background: C.dim, color: C.text, border: `1px solid ${C.border}`, fontSize: 13 }}>
              <option>BUY</option><option>SELL</option>
            </select>
          </div>
          <input placeholder={`Entry Price (live: ${fmt(cp)})`} value={newT.entry} onChange={e => setNewT(p => ({ ...p, entry: e.target.value }))} style={{ width: "100%", padding: 9, borderRadius: 7, background: C.dim, color: C.text, border: `1px solid ${C.border}`, fontSize: 13, marginBottom: 8, boxSizing: "border-box" }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={logTrade} style={{ flex: 1, padding: 10, background: C.green, color: "#000", fontWeight: 800, border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13 }}>Log Trade</button>
            <button onClick={() => setAddTrade(false)} style={{ flex: 1, padding: 10, background: C.dim, color: C.muted, border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13 }}>Cancel</button>
          </div>
        </div>
      )}

      {trades.map(t => (
        <div key={t.id} style={{ ...S.card, borderColor: t.win ? `${C.green}35` : `${C.red}35` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                <span style={{ background: t.type==="BUY"?`${C.green}28`:`${C.red}28`, color: t.type==="BUY"?C.green:C.red, fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 4, letterSpacing: .4 }}>{t.type}</span>
                <span style={{ color: C.text, fontWeight: 700, fontSize: 13 }}>{t.ins}</span>
                <span style={{ color: C.muted, fontSize: 11 }}>{t.time}</span>
              </div>
              <div style={{ color: C.muted, fontSize: 11 }}>₹{fmt(t.entry)} → ₹{fmt(t.exit)}</div>
              <div style={{ color: C.muted, fontSize: 11 }}>⏱ {t.dur}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ color: t.pnl >= 0 ? C.green : C.red, fontWeight: 900, fontSize: 16, fontVariantNumeric: "tabular-nums" }}>{t.pnl >= 0 ? "+" : ""}₹{fmt(t.pnl,0)}</div>
              <div style={{ color: t.win ? C.green : C.red, fontSize: 10, fontWeight: 700, marginTop: 2 }}>{t.win ? "✓ WIN" : "✗ LOSS"}</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  // ─────────────────────────────────────────
  // TAB: NEWS
  // ─────────────────────────────────────────
  const NewsTab = () => {
    const cats = ["All","Market","Earnings","Sector","Technical","Corporate","Global"];
    const filtered = newsFilter === "All" ? NEWS : NEWS.filter(n => n.cat === newsFilter);
    return (
      <div style={{ padding: "0 14px 90px" }}>
        {/* Market Overview */}
        <div style={{ ...S.card }}>
          <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>📊 Today's Market Overview</div>
          {Object.entries(prices).slice(0, 3).map(([name, p]) => {
            const ch = +(p.cur - p.prev).toFixed(2);
            const pc = +((ch / p.prev) * 100).toFixed(2);
            return (
              <div key={name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: `1px solid ${C.dim}` }}>
                <span style={{ color: C.text, fontSize: 13, fontWeight: 700 }}>{name}</span>
                <div style={{ textAlign: "right" }}>
                  <div style={{ color: C.text, fontSize: 13, fontVariantNumeric: "tabular-nums" }}>₹{fmt(p.cur,0)}</div>
                  <div style={{ color: ch >= 0 ? C.green : C.red, fontSize: 11, fontWeight: 600 }}>{ch >= 0 ? "+" : ""}{fmt(ch,0)} ({pc >= 0 ? "+" : ""}{pc}%)</div>
                </div>
              </div>
            );
          })}
          <p style={{ color: C.muted, fontSize: 12, lineHeight: 1.5, marginTop: 10, marginBottom: 0 }}>
            Markets boosted by strong <span style={{ color: C.green }}>FII inflows ₹8,400 Cr</span> and RBI rate hold. Banking &amp; Infra lead; IT lags on muted Q3 earnings.
          </p>
        </div>

        {/* Category Filter */}
        <div style={{ display: "flex", gap: 6, marginBottom: 10, overflowX: "auto", paddingBottom: 2 }}>
          {cats.map(c => (
            <button key={c} onClick={() => setNewsFilter(c)} style={{ padding: "5px 12px", borderRadius: 7, background: c === newsFilter ? C.green : C.card, color: c === newsFilter ? "#000" : C.muted, border: `1px solid ${C.border}`, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap", fontWeight: c === newsFilter ? 800 : 400 }}>{c}</button>
          ))}
        </div>

        {/* News Detail Modal */}
        {selNews && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", zIndex: 200, display: "flex", alignItems: "flex-end" }} onClick={() => setSelNews(null)}>
            <div onClick={e => e.stopPropagation()} style={{ background: "#0b1020", borderRadius: "18px 18px 0 0", padding: 20, width: "100%", maxHeight: "72vh", overflowY: "auto", boxSizing: "border-box" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <span style={{ color: C.green, fontSize: 11, fontWeight: 700, letterSpacing: .4, textTransform: "uppercase" }}>{selNews.cat} · {selNews.impact} IMPACT</span>
                <button onClick={() => setSelNews(null)} style={{ background: C.dim, border: "none", color: C.muted, cursor: "pointer", borderRadius: 6, padding: "4px 8px" }}><X size={16} /></button>
              </div>
              <p style={{ color: C.text, fontWeight: 700, fontSize: 16, lineHeight: 1.4, marginBottom: 12 }}>{selNews.headline}</p>
              <p style={{ color: C.muted, fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>{selNews.detail}</p>
              <div style={{ color: C.text, fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Affected Stocks</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                {selNews.stocks.map(s => <span key={s} style={{ background: C.dim, color: C.blue, fontSize: 12, padding: "4px 10px", borderRadius: 6, fontWeight: 700 }}>{s}</span>)}
              </div>
              <div style={{ color: C.muted, fontSize: 11 }}>Published {selNews.time}</div>
            </div>
          </div>
        )}

        {filtered.map(n => <NewsCard key={n.id} n={n} onClick={setSelNews} />)}
      </div>
    );
  };

  // ─────────────────────────────────────────
  // TAB: SETTINGS
  // ─────────────────────────────────────────
  const SettingsTab = () => (
    <div style={{ padding: "0 14px 90px" }}>
      {[
        { l: "Daily Risk Limit (₹)", k: "riskLimit" },
        { l: "Profit Target (%)",    k: "profitPct"  },
        { l: "Stop Loss (%)",        k: "slPct"      },
      ].map(s => (
        <div key={s.k} style={{ ...S.card }}>
          <div style={{ color: C.muted, fontSize: 10, marginBottom: 6, textTransform: "uppercase", letterSpacing: .4 }}>{s.l}</div>
          <input type="number" value={sett[s.k]} onChange={e => setSett(p => ({ ...p, [s.k]: +e.target.value }))} style={{ width: "100%", padding: 10, borderRadius: 7, background: C.dim, color: C.green, border: `1px solid ${C.border}`, fontSize: 19, fontWeight: 900, boxSizing: "border-box" }} />
        </div>
      ))}

      <div style={{ ...S.card }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Indicators</div>
        {Object.entries(sett.ind).map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.dim}` }}>
            <span style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>{k.toUpperCase()}</span>
            <Toggle on={v} onToggle={() => setSett(p => ({ ...p, ind: { ...p.ind, [k]: !v } }))} />
          </div>
        ))}
      </div>

      <div style={{ ...S.card }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
          Refresh Rate · <span style={{ color: C.green }}>{refresh}s</span>
        </div>
        <input type="range" min={3} max={60} value={refresh} onChange={e => setRefresh(+e.target.value)} style={{ width: "100%", accentColor: C.green, margin: "4px 0" }} />
        <div style={{ display: "flex", justifyContent: "space-between", color: C.muted, fontSize: 10 }}><span>3s (fast)</span><span>60s (slow)</span></div>
      </div>

      <div style={{ ...S.card, textAlign: "center" }}>
        <div style={{ color: C.green, fontSize: 12, marginBottom: 4 }}>💡 Pro tip</div>
        <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.5 }}>You can change ALL settings via the AI Chat — just say "change refresh to 3s" or "disable MACD".</div>
      </div>
    </div>
  );

  // ─────────────────────────────────────────
  // NAVIGATION
  // ─────────────────────────────────────────
  const TABS = [
    { id: "dashboard", Icon: Home,      label: "Home"      },
    { id: "charts",    Icon: BarChart2,  label: "Charts"    },
    { id: "portfolio", Icon: Briefcase,  label: "Portfolio" },
    { id: "trades",    Icon: Activity,   label: "Trades"    },
    { id: "news",      Icon: Newspaper,  label: "News"      },
    { id: "settings",  Icon: Settings,   label: "More"      },
  ];

  const CONTENT = { dashboard: Dashboard, charts: Charts, portfolio: Portfolio, trades: Trades, news: NewsTab, settings: SettingsTab };
  const ActiveTab = CONTENT[tab];

  // ─────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────
  return (
    <div style={{ background: C.bg, minHeight: "100vh", maxWidth: 480, margin: "0 auto", position: "relative", fontFamily: "'SF Pro Display',-apple-system,BlinkMacSystemFont,sans-serif" }}>

      {/* ── Header ── */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 50 }}>
        <div>
          <div style={{ color: C.green, fontWeight: 900, fontSize: 19, letterSpacing: -.5 }}>⚡ ScalpAI</div>
          <div style={{ color: C.muted, fontSize: 10, letterSpacing: .3 }}>NSE · {new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} IST</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5, background: `${C.green}18`, border: `1px solid ${C.green}45`, borderRadius: 7, padding: "4px 10px" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: C.green }} />
            <span style={{ color: C.green, fontSize: 11, fontWeight: 700 }}>LIVE</span>
          </div>
          <button onClick={() => setChatOpen(true)} style={{ background: `${C.blue}22`, border: `1px solid ${C.blue}55`, borderRadius: 8, padding: "6px 12px", color: C.blue, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
            <MessageCircle size={14} />
            <span style={{ fontSize: 11, fontWeight: 700 }}>AI</span>
          </button>
        </div>
      </div>

      {/* ── Page Title ── */}
      <div style={{ padding: "12px 16px 4px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ color: C.text, fontWeight: 900, fontSize: 21, letterSpacing: -.5 }}>{TABS.find(t => t.id === tab)?.label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 5, color: C.muted, fontSize: 11 }}>
          <RefreshCw size={11} /> {refresh}s
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ paddingTop: 8 }}>
        <ActiveTab />
      </div>

      {/* ── Bottom Nav ── */}
      <div style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 480, background: C.card, borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-around", padding: "8px 0 12px", zIndex: 50 }}>
        {TABS.map(({ id, Icon, label }) => (
          <button key={id} onClick={() => setTab(id)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "4px 8px", background: "none", border: "none", cursor: "pointer" }}>
            <Icon size={21} color={tab === id ? C.green : C.muted} />
            <span style={{ fontSize: 9, color: tab === id ? C.green : C.muted, fontWeight: tab === id ? 800 : 400, letterSpacing: .3 }}>{label}</span>
          </button>
        ))}
      </div>

      {/* ── AI Chat Overlay ── */}
      {chatOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", flexDirection: "column", background: C.bg }}>
          {/* Chat Header */}
          <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>⚡ AI Trading Assistant</div>
              <div style={{ color: C.muted, fontSize: 10 }}>Powered by Claude · Modifies app in real-time</div>
            </div>
            <button onClick={() => setChatOpen(false)} style={{ background: C.dim, border: "none", color: C.muted, cursor: "pointer", borderRadius: 8, padding: "6px 10px" }}><X size={18} /></button>
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
            {msgs.map((m, i) => (
              <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 14 }}>
                {m.role === "assistant" && (
                  <div style={{ width: 28, height: 28, borderRadius: "50%", background: `${C.green}22`, border: `1px solid ${C.green}45`, display: "flex", alignItems: "center", justifyContent: "center", marginRight: 8, flexShrink: 0, fontSize: 12 }}>⚡</div>
                )}
                <div style={{ maxWidth: "82%", background: m.role === "user" ? `${C.blue}22` : C.card, border: `1px solid ${m.role === "user" ? C.blue + "45" : C.border}`, borderRadius: m.role === "user" ? "16px 4px 16px 16px" : "4px 16px 16px 16px", padding: "10px 14px" }}>
                  <div style={{ color: C.text, fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{m.content}</div>
                </div>
              </div>
            ))}
            {chatLoading && (
              <div style={{ display: "flex", gap: 5, padding: "10px 14px", background: C.card, border: `1px solid ${C.border}`, borderRadius: "4px 16px 16px 16px", width: "fit-content", marginBottom: 14 }}>
                {[0,1,2].map(i => <div key={i} style={{ width: 8, height: 8, borderRadius: "50%", background: C.green, opacity: .7 }} />)}
              </div>
            )}
            <div ref={chatEnd} />
          </div>

          {/* Quick hints */}
          <div style={{ padding: "8px 16px 0", background: C.card, borderTop: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 8 }}>
              {["Switch to BANK NIFTY","Analyze RSI signal","Refresh rate 3s","Disable MACD","Go to News tab"].map(h => (
                <button key={h} onClick={() => setChatInput(h)} style={{ padding: "5px 10px", borderRadius: 6, background: C.dim, color: C.muted, border: `1px solid ${C.border}`, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}>{h}</button>
              ))}
            </div>
            {/* Input */}
            <div style={{ display: "flex", gap: 8, paddingBottom: 16 }}>
              <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMsg()} placeholder="Ask anything or control the app…" style={{ flex: 1, padding: "12px 14px", borderRadius: 12, background: C.dim, color: C.text, border: `1px solid ${C.border}`, fontSize: 14, outline: "none" }} />
              <button onClick={sendMsg} disabled={chatLoading} style={{ padding: "12px 16px", borderRadius: 12, background: chatLoading ? C.dim : C.green, border: "none", cursor: chatLoading ? "not-allowed" : "pointer", display: "flex", alignItems: "center" }}>
                <Send size={18} color={chatLoading ? C.muted : "#000"} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Global Styles ── */}
      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
        *{ -webkit-tap-highlight-color:transparent; box-sizing:border-box; }
        ::-webkit-scrollbar{ width:3px; height:3px; }
        ::-webkit-scrollbar-thumb{ background:#1e3050; border-radius:2px; }
        input[type=range]{ cursor:pointer; }
        select{ appearance:none; }
      `}</style>
    </div>
  );
}
