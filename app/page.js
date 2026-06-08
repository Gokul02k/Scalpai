"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  AreaChart, Area, BarChart, Bar, YAxis,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  Settings, ChevronDown, MessageCircle, X, Send, Newspaper, BarChart2,
  Briefcase, Home, Activity, ArrowUp, ArrowDown, Zap, RefreshCw, Star,
  Upload, Plus, Trash2, Bell, Sun, Moon, Timer, Calculator,
} from "lucide-react";
import {
  fetchAllMarketData, fetchCandles, fetchPortfolioPrices, fetchNews, fetchStockQuote, genFallbackCandles,
} from "./lib/marketData";
import { analyzeFromCandles } from "./lib/indicators";
import { generateIndexSignals, generatePortfolioSignals, parsePortfolioCSV } from "./lib/signals";
import { loadPersisted, savePersisted } from "./lib/storage";
import { getMarketStatus } from "./lib/marketHours";
import { THEMES, cardStyle } from "./lib/themes";

const INSTRUMENTS = {
  "NIFTY":        { base: 25000, vol: 0.0012, lot: 50 },
  "SENSEX":       { base: 82000, vol: 0.0010, lot: 10 },
  "BANK NIFTY":   { base: 55000, vol: 0.0015, lot: 15 },
  "FINNIFTY":     { base: 23800, vol: 0.0013, lot: 40 },
  "MIDCAP NIFTY": { base: 12500, vol: 0.0018, lot: 75 },
};

const DEFAULT_PORTFOLIO = [
  { id: 1, name: "RELIANCE",  qty: 10, buy: 2850, cur: 2920, sector: "Energy"  },
  { id: 2, name: "TCS",       qty: 5,  buy: 3980, cur: 3856, sector: "IT"      },
  { id: 3, name: "HDFCBANK",  qty: 20, buy: 1680, cur: 1720, sector: "Banking" },
  { id: 4, name: "INFY",      qty: 15, buy: 1820, cur: 1795, sector: "IT"      },
  { id: 5, name: "ICICIBANK", qty: 25, buy: 1145, cur: 1180, sector: "Banking" },
];

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
      <p style={{ color: C.text, fontSize: 13, lineHeight: 1.45, margin: "0 0 8px" }}>{n.headline}</p>
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

export default function App() {
  const [theme, setTheme] = useState("dark");
  const C = THEMES[theme];
  const S = { card: cardStyle(C) };

  const [hydrated, setHydrated] = useState(false);
  const [instrument, setInstrument] = useState("NIFTY");
  const [dropOpen, setDropOpen] = useState(false);
  const [tab, setTab] = useState("dashboard");
  const [tf, setTf] = useState("5m");
  const [refresh, setRefresh] = useState(5);

  const [prices, setPrices] = useState(initPrices);
  const [candles, setCandles] = useState({});
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

  const [sett, setSett] = useState({
    riskLimit: 10000, profitPct: 1.5, slPct: 0.8,
    ind: { rsi: true, macd: true, bb: true, ema20: true, ema50: true, vol: true },
  });
  const [alerts, setAlerts] = useState({ sound: true, notification: true });

  const [activeScalp, setActiveScalp] = useState(null);
  const [scalpElapsed, setScalpElapsed] = useState(0);
  const [marketStatus, setMarketStatus] = useState(() => getMarketStatus());

  const [calc, setCalc] = useState({ risk: 5000, entry: 25000, sl: 24900, exit: 25200, target: 25300 });

  const [chatOpen, setChatOpen] = useState(false);
  const [msgs, setMsgs] = useState([
    { role: "assistant", content: "👋 Hi! I'm your AI scalping assistant.\n\nTry: \"Switch to BANK NIFTY\", \"Light mode\", \"Add RELIANCE to watchlist\", or \"What does RSI say?\"" },
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEnd = useRef(null);
  const csvRef = useRef(null);
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
    }
    setHydrated(true);
  }, []);

  // Persist on change
  useEffect(() => {
    if (!hydrated) return;
    savePersisted({ theme, portfolio, trades, watchlists, activeWatchlist, sett, refresh, alerts, activeScalp });
  }, [hydrated, theme, portfolio, trades, watchlists, activeWatchlist, sett, refresh, alerts, activeScalp]);

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

  // Real candles on instrument/tf change
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await fetchCandles(instrument, tf);
      if (cancelled) return;
      if (data?.length) {
        setCandles((prev) => ({ ...prev, [instrument]: data }));
      } else {
        const base = pricesRef.current[instrument]?.cur ?? INSTRUMENTS[instrument].base;
        setCandles((prev) => ({ ...prev, [instrument]: genFallbackCandles(base, 65, INSTRUMENTS[instrument].vol) }));
      }
    })();
    return () => { cancelled = true; };
  }, [instrument, tf]);

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
  }, [refresh]);

  // Watchlist prices
  useEffect(() => {
    const syms = watchlists[activeWatchlist] || [];
    if (!syms.length) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(syms.map(async (s) => {
        const q = await fetchStockQuote(s);
        return [s, q?.current ?? null];
      }));
      if (!cancelled) setWatchPrices(Object.fromEntries(entries));
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
  const analysis = useMemo(() => {
    if (!instCandles.length) return null;
    return analyzeFromCandles(instCandles);
  }, [instCandles]);

  useEffect(() => {
    const cp = prices[instrument]?.cur;
    if (!analysis || !cp) return;
    setSignals([
      ...generateIndexSignals(analysis, cp, instrument, sett),
      ...generatePortfolioSignals(portfolio, sett),
    ]);
  }, [analysis, prices, instrument, sett, portfolio]);

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

  const execCmd = useCallback((json) => {
    try {
      const { action, value } = JSON.parse(json);
      if (action === "changeInstrument" && INSTRUMENTS[value]) setInstrument(value);
      if (action === "changeTimeframe") setTf(value);
      if (action === "changeRefreshRate") setRefresh(+value);
      if (action === "toggleIndicator") setSett((p) => ({ ...p, ind: { ...p.ind, [value]: !p.ind[value] } }));
      if (action === "setRiskLimit") setSett((p) => ({ ...p, riskLimit: +value }));
      if (action === "setTheme") setTheme(value === "light" ? "light" : "dark");
      if (action === "addStock") setPortfolio((p) => [...p, { id: Date.now(), name: value.name, qty: +value.qty, buy: +value.price, cur: +value.price, sector: value.sector || "Other" }]);
      if (action === "addToWatchlist") {
        const sym = (value.symbol || value).toUpperCase();
        setWatchlists((w) => ({ ...w, [activeWatchlist]: [...new Set([...(w[activeWatchlist] || []), sym])] }));
      }
      if (action === "switchTab") setTab(value);
    } catch (_) {}
  }, [activeWatchlist]);

  const sendMsg = async () => {
    if (!chatInput.trim() || chatLoading) return;
    const text = chatInput.trim();
    setChatInput("");
    setMsgs((p) => [...p, { role: "user", content: text }]);
    setChatLoading(true);
    try {
      const sys = `You are an AI scalping assistant for Indian markets.
Instrument: ${instrument} @ ₹${fmt(cp)} | RSI: ${analysis?.rsi ?? "—"} | Theme: ${theme}
Commands via <CMD>{"action":"...","value":"..."}</CMD>:
changeInstrument, changeTimeframe, changeRefreshRate, toggleIndicator, setRiskLimit, setTheme, addStock, addToWatchlist, switchTab
Tabs: dashboard|charts|portfolio|trades|news|watchlist|settings`;
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system: sys, messages: [...msgs.slice(-8), { role: "user", content: text }] }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsgs((p) => [...p, { role: "assistant", content: `⚠️ ${data.error || "AI unavailable"}` }]);
        return;
      }
      const full = data.text ?? "Sorry, try again.";
      const match = full.match(/<CMD>(.*?)<\/CMD>/s);
      if (match) execCmd(match[1].trim());
      setMsgs((p) => [...p, { role: "assistant", content: full.replace(/<CMD>.*?<\/CMD>/gs, "").trim() }]);
    } catch {
      setMsgs((p) => [...p, { role: "assistant", content: "⚠️ Connection error." }]);
    } finally {
      setChatLoading(false);
    }
  };

  const quickTrade = (type) => {
    setActiveScalp({ type, ins: instrument, entry: cp, startTime: Date.now() });
    setNewT({ ins: instrument, type, entry: String(cp), qty: 1, date: todayStr() });
    setAddTrade(true);
    setTab("trades");
  };

  const logTrade = () => {
    if (!newT.entry) return;
    const lot = INSTRUMENTS[newT.ins].lot;
    const exit = +(+newT.entry * (newT.type === "BUY" ? 1.0045 : 0.9955)).toFixed(2);
    const pnl = +((exit - +newT.entry) * (newT.type === "BUY" ? 1 : -1) * +newT.qty * lot).toFixed(0);
    setTrades((p) => [{
      id: Date.now(), ins: newT.ins, type: newT.type, entry: +newT.entry, exit, qty: +newT.qty,
      time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
      date: newT.date || todayStr(), dur: activeScalp ? formatElapsed(scalpElapsed) : "—", pnl, win: pnl > 0,
    }, ...p]);
    setActiveScalp(null);
    setAddTrade(false);
    setNewT({ ins: "NIFTY", type: "BUY", entry: "", qty: 1, date: todayStr() });
  };

  const handleCSV = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const parsed = parsePortfolioCSV(ev.target.result);
      if (parsed.length) setPortfolio(parsed);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const addToWatchlist = () => {
    const sym = watchInput.trim().toUpperCase();
    if (!sym) return;
    setWatchlists((w) => ({ ...w, [activeWatchlist]: [...new Set([...(w[activeWatchlist] || []), sym])] }));
    setWatchInput("");
  };

  const removeFromWatchlist = (sym) => {
    setWatchlists((w) => ({ ...w, [activeWatchlist]: (w[activeWatchlist] || []).filter((s) => s !== sym) }));
  };

  const requestNotifPerm = () => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }
  };

  const posSize = calc.entry && calc.sl ? Math.floor(calc.risk / Math.abs(calc.entry - calc.sl)) : 0;
  const pnlCalc = calc.entry && calc.exit ? +((calc.exit - calc.entry) * posSize).toFixed(0) : 0;
  const rrCalc = calc.entry && calc.sl && calc.target
    ? (Math.abs(calc.target - calc.entry) / Math.abs(calc.entry - calc.sl)).toFixed(2) : "—";

  const indexSignals = signals.filter((s) => s.scope === "index");
  const portSignals = signals.filter((s) => s.scope === "portfolio");
  const portfolioNews = news.filter((n) => (n.stocks || []).some((s) => stockNamesKey.split(",").includes(s)));
  const filteredNews = newsFilter === "All" ? news : news.filter((n) => n.cat === newsFilter);

  // ── TAB COMPONENTS ──
  const Dashboard = () => (
    <div style={{ padding: "0 14px 90px" }}>
      <div style={{ position: "relative", marginBottom: 12 }}>
        <button onClick={() => setDropOpen(!dropOpen)} style={{ display: "flex", alignItems: "center", gap: 8, background: C.card, border: `1px solid ${isUp ? C.green + "60" : C.red + "60"}`, borderRadius: 10, padding: "10px 14px", color: C.text, fontSize: 15, fontWeight: 800, cursor: "pointer", width: "100%" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: marketStatus.open ? C.green : C.yellow, boxShadow: `0 0 6px ${marketStatus.open ? C.green : C.yellow}` }} />
          {instrument}
          <ChevronDown size={15} style={{ marginLeft: "auto", color: C.muted }} />
        </button>
        {dropOpen && (
          <div style={{ position: "absolute", top: "105%", left: 0, right: 0, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, zIndex: 100 }}>
            {Object.keys(INSTRUMENTS).map((k) => (
              <button key={k} onClick={() => { setInstrument(k); setDropOpen(false); }} style={{ display: "flex", width: "100%", padding: "12px 16px", background: k === instrument ? `${C.green}18` : "transparent", color: k === instrument ? C.green : C.text, border: "none", cursor: "pointer", fontSize: 14, fontWeight: k === instrument ? 800 : 400, borderBottom: `1px solid ${C.border}` }}>{k}</button>
            ))}
          </div>
        )}
      </div>

      {activeScalp && (
        <div style={{ ...S.card, borderColor: `${C.yellow}55`, background: `${C.yellow}10` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <Timer size={14} color={C.yellow} />
            <span style={{ color: C.yellow, fontWeight: 800, fontSize: 12 }}>ACTIVE SCALP — {activeScalp.type} {activeScalp.ins}</span>
          </div>
          <div style={{ color: C.text, fontSize: 22, fontWeight: 900 }}>{formatElapsed(scalpElapsed)}</div>
          <div style={{ color: C.muted, fontSize: 11 }}>Entry ₹{fmt(activeScalp.entry)}</div>
          <button onClick={() => setActiveScalp(null)} style={{ marginTop: 8, padding: "6px 12px", background: C.dim, border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, cursor: "pointer", fontSize: 11 }}>End Scalp</button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <button onClick={() => quickTrade("BUY")} style={{ flex: 1, padding: 12, borderRadius: 10, background: C.green, color: "#000", fontWeight: 800, border: "none", fontSize: 14, cursor: "pointer" }}>⚡ QUICK BUY</button>
        <button onClick={() => quickTrade("SELL")} style={{ flex: 1, padding: 12, borderRadius: 10, background: C.red, color: "#fff", fontWeight: 800, border: "none", fontSize: 14, cursor: "pointer" }}>⚡ QUICK SELL</button>
      </div>

      <div style={{ background: `linear-gradient(135deg,${C.card} 0%,${C.dim} 100%)`, border: `1px solid ${isUp ? C.green + "40" : C.red + "40"}`, borderRadius: 14, padding: 16, marginBottom: 10 }}>
        <div style={{ color: C.muted, fontSize: 10, marginBottom: 4, textTransform: "uppercase" }}>{instrument} · {isLive ? `${(dataSource || "LIVE").toUpperCase()}` : "SIMULATED"}</div>
        <div style={{ color: C.text, fontSize: 31, fontWeight: 900, fontVariantNumeric: "tabular-nums" }}>₹{fmt(cp)}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 5 }}>
          {isUp ? <ArrowUp size={13} color={C.green} /> : <ArrowDown size={13} color={C.red} />}
          <span style={{ color: isUp ? C.green : C.red, fontWeight: 700, fontSize: 14 }}>{fmtD(chg)} ({pct >= 0 ? "+" : ""}{pct}%)</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
        {[
          { l: "Period P&L", v: `₹${fmt(totPnL, 0)}`, c: totPnL >= 0 ? C.green : C.red },
          { l: "Win Rate", v: `${winRate}%`, c: winRate >= 60 ? C.green : C.yellow },
          { l: "Trades", v: filteredTrades.length, c: C.blue },
          { l: "Portfolio P&L", v: `₹${fmt(portPnL, 0)}`, c: portPnL >= 0 ? C.green : C.red },
        ].map((s) => (
          <div key={s.l} style={{ ...S.card, marginBottom: 0, padding: 12 }}>
            <div style={{ color: C.muted, fontSize: 10, marginBottom: 4, textTransform: "uppercase" }}>{s.l}</div>
            <div style={{ color: s.c, fontWeight: 900, fontSize: 20 }}>{s.v}</div>
          </div>
        ))}
      </div>

      <div style={{ ...S.card }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ color: C.text, fontWeight: 700, fontSize: 13 }}>{instrument} · {tf}</span>
          <div style={{ display: "flex", gap: 3 }}>
            {["1m", "5m", "15m", "1h"].map((t) => (
              <button key={t} onClick={() => setTf(t)} style={{ padding: "3px 8px", borderRadius: 5, background: t === tf ? C.green : C.dim, color: t === tf ? "#000" : C.muted, border: "none", fontSize: 10, cursor: "pointer", fontWeight: 700 }}>{t}</button>
            ))}
          </div>
        </div>
        <CandleChart candles={instCandles.slice(-35)} height={165} C={C} />
      </div>

      {sett.ind.rsi && analysis && (
        <div style={{ ...S.card }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ color: C.muted, fontSize: 12 }}>RSI (14)</span>
            <span style={{ color: analysis.rsi > 70 ? C.red : analysis.rsi < 30 ? C.green : C.yellow, fontWeight: 700, fontSize: 13 }}>
              {analysis.rsi} · {analysis.rsi > 70 ? "Overbought" : analysis.rsi < 30 ? "Oversold" : "Neutral"}
            </span>
          </div>
          <div style={{ background: C.dim, borderRadius: 4, height: 6 }}>
            <div style={{ width: `${analysis.rsi}%`, height: "100%", background: analysis.rsi > 70 ? C.red : analysis.rsi < 30 ? C.green : C.yellow, borderRadius: 4 }} />
          </div>
        </div>
      )}

      {sett.ind.macd && analysis && (
        <div style={{ ...S.card }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
            <span style={{ color: C.muted, fontSize: 12 }}>MACD</span>
            <span style={{ color: analysis.macd.h > 0 ? C.green : C.red, fontWeight: 700, fontSize: 13 }}>{analysis.macd.h > 0 ? "▲ Bullish" : "▼ Bearish"}</span>
          </div>
          <div style={{ display: "flex", gap: 14, fontSize: 11, color: C.muted }}>
            <span>MACD <b style={{ color: C.blue }}>{analysis.macd.v}</b></span>
            <span>Signal <b style={{ color: C.yellow }}>{analysis.macd.s}</b></span>
            <span>Hist <b style={{ color: analysis.macd.h > 0 ? C.green : C.red }}>{analysis.macd.h}</b></span>
          </div>
        </div>
      )}

      <div style={{ marginTop: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <Zap size={14} color={C.yellow} />
          <span style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>Index Signals</span>
        </div>
        {indexSignals.length
          ? indexSignals.map((s, i) => <SignalCard key={i} sig={s} price={cp} C={C} />)
          : <div style={{ ...S.card, textAlign: "center", color: C.muted, padding: 20 }}>Scanning…</div>}
      </div>

      {portSignals.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ color: C.muted, fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Portfolio Signals</div>
          {portSignals.map((s, i) => <SignalCard key={i} sig={s} price={s.target || cp} C={C} />)}
        </div>
      )}
    </div>
  );

  const Charts = () => (
    <div style={{ padding: "0 14px 90px" }}>
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

  const PortfolioTab = () => {
    const retPct = portCost ? +((portPnL / portCost) * 100).toFixed(2) : 0;
    return (
      <div style={{ padding: "0 14px 90px" }}>
        <div style={{ ...S.card, background: `linear-gradient(135deg,${C.card},${C.dim})` }}>
          <div style={{ color: C.muted, fontSize: 10, marginBottom: 4, textTransform: "uppercase" }}>Total Value</div>
          <div style={{ color: C.text, fontSize: 27, fontWeight: 900 }}>₹{fmt(portVal, 0)}</div>
          <div style={{ color: portPnL >= 0 ? C.green : C.red, fontSize: 14, fontWeight: 700 }}>{portPnL >= 0 ? "+" : ""}₹{fmt(portPnL, 0)} ({retPct >= 0 ? "+" : ""}{retPct}%)</div>
        </div>

        <input ref={csvRef} type="file" accept=".csv,.txt" style={{ display: "none" }} onChange={handleCSV} />
        <button onClick={() => csvRef.current?.click()} style={{ width: "100%", padding: 12, borderRadius: 10, background: `${C.blue}18`, border: `1px dashed ${C.blue}55`, color: C.blue, fontWeight: 700, cursor: "pointer", marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          <Upload size={14} /> Upload Portfolio CSV
        </button>

        {portfolio.map((s) => {
          const pnl = (s.cur - s.buy) * s.qty;
          const pnlPct = +((s.cur - s.buy) / s.buy * 100).toFixed(2);
          const up = pnl >= 0;
          return (
            <div key={s.id} style={{ ...S.card, borderColor: up ? `${C.green}35` : `${C.red}35` }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div>
                  <div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>{s.name}</div>
                  <div style={{ color: C.muted, fontSize: 11 }}>{s.sector} · {s.qty} shares · Avg ₹{fmt(s.buy)}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>₹{fmt(s.cur)}</div>
                  <div style={{ color: up ? C.green : C.red, fontSize: 12, fontWeight: 700 }}>{up ? "+" : ""}₹{fmt(pnl, 0)} ({pnlPct >= 0 ? "+" : ""}{pnlPct}%)</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

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
      <div style={{ ...S.card }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Market Overview</div>
        {Object.entries(prices).slice(0, 5).map(([name, p]) => {
          const ch = +(p.cur - p.prev).toFixed(2);
          const pc = +((ch / p.prev) * 100).toFixed(2);
          return (
            <div key={name} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${C.dim}` }}>
              <span style={{ color: C.text, fontWeight: 700 }}>{name}</span>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: C.text }}>₹{fmt(p.cur, 0)}</div>
                <div style={{ color: ch >= 0 ? C.green : C.red, fontSize: 11 }}>{ch >= 0 ? "+" : ""}{fmt(ch, 0)} ({pc >= 0 ? "+" : ""}{pc}%)</div>
              </div>
            </div>
          );
        })}
        {newsOverview && <p style={{ color: C.muted, fontSize: 12, lineHeight: 1.5, marginTop: 10, marginBottom: 0 }}>{newsOverview}</p>}
      </div>

      {portfolioNews.length > 0 && (
        <div style={{ ...S.card, borderColor: `${C.blue}44` }}>
          <div style={{ color: C.blue, fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Portfolio-Linked News</div>
          {portfolioNews.slice(0, 3).map((n) => <NewsCard key={n.id} n={n} onClick={setSelNews} C={C} />)}
        </div>
      )}

      <div style={{ display: "flex", gap: 6, marginBottom: 10, overflowX: "auto" }}>
        {["All", "Market", "Earnings", "Sector", "Technical", "Corporate", "Global"].map((c) => (
          <button key={c} onClick={() => setNewsFilter(c)} style={{ padding: "5px 12px", borderRadius: 7, background: c === newsFilter ? C.green : C.card, color: c === newsFilter ? "#000" : C.muted, border: `1px solid ${C.border}`, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap", fontWeight: c === newsFilter ? 800 : 400 }}>{c}</button>
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
            <p style={{ color: C.muted, fontSize: 13, lineHeight: 1.6 }}>{selNews.detail}</p>
          </div>
        </div>
      )}

      {filteredNews.length ? filteredNews.map((n) => <NewsCard key={n.id} n={n} onClick={setSelNews} C={C} />)
        : <div style={{ ...S.card, textAlign: "center", color: C.muted }}>No news available</div>}
    </div>
  );

  const WatchlistTab = () => (
    <div style={{ padding: "0 14px 90px" }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 10, overflowX: "auto" }}>
        {Object.keys(watchlists).map((name) => (
          <button key={name} onClick={() => setActiveWatchlist(name)} style={{ padding: "6px 12px", borderRadius: 8, background: activeWatchlist === name ? C.green : C.card, color: activeWatchlist === name ? "#000" : C.muted, border: `1px solid ${C.border}`, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap", fontWeight: 700 }}>{name}</button>
        ))}
      </div>

      <div style={{ ...S.card, display: "flex", gap: 8 }}>
        <input value={watchInput} onChange={(e) => setWatchInput(e.target.value.toUpperCase())} placeholder="Add symbol (e.g. RELIANCE)" style={{ flex: 1, padding: 10, borderRadius: 8, background: C.dim, color: C.text, border: `1px solid ${C.border}` }} onKeyDown={(e) => e.key === "Enter" && addToWatchlist()} />
        <button onClick={addToWatchlist} style={{ padding: "10px 14px", background: C.green, border: "none", borderRadius: 8, cursor: "pointer" }}><Plus size={16} color="#000" /></button>
      </div>

      {(watchlists[activeWatchlist] || []).map((sym) => (
        <div key={sym} style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ color: C.text, fontWeight: 800, fontSize: 14 }}>{sym}</div>
            <div style={{ color: C.muted, fontSize: 11 }}>{watchPrices[sym] ? `₹${fmt(watchPrices[sym])}` : "Loading…"}</div>
          </div>
          <button onClick={() => removeFromWatchlist(sym)} style={{ background: `${C.red}18`, border: "none", borderRadius: 6, padding: 6, cursor: "pointer" }}><Trash2 size={14} color={C.red} /></button>
        </div>
      ))}
      {!(watchlists[activeWatchlist] || []).length && <div style={{ ...S.card, textAlign: "center", color: C.muted }}>Watchlist empty</div>}
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

      {[
        { l: "Daily Risk Limit (₹)", k: "riskLimit" },
        { l: "Profit Target (%)", k: "profitPct" },
        { l: "Stop Loss (%)", k: "slPct" },
      ].map((s) => (
        <div key={s.k} style={S.card}>
          <div style={{ color: C.muted, fontSize: 10, marginBottom: 6, textTransform: "uppercase" }}>{s.l}</div>
          <input type="number" value={sett[s.k]} onChange={(e) => setSett((p) => ({ ...p, [s.k]: +e.target.value }))} style={{ width: "100%", padding: 10, borderRadius: 7, background: C.dim, color: C.green, border: `1px solid ${C.border}`, fontSize: 19, fontWeight: 900, boxSizing: "border-box" }} />
        </div>
      ))}

      <div style={S.card}>
        <div style={{ color: C.text, fontWeight: 700, marginBottom: 10 }}>Indicators</div>
        {Object.entries(sett.ind).map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.dim}` }}>
            <span style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>{k.toUpperCase()}</span>
            <Toggle on={v} onToggle={() => setSett((p) => ({ ...p, ind: { ...p.ind, [k]: !v } }))} C={C} />
          </div>
        ))}
      </div>

      <div style={S.card}>
        <div style={{ color: C.text, fontWeight: 700, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}><Bell size={14} /> Alerts</div>
        {[{ k: "sound", l: "Sound Beep" }, { k: "notification", l: "Browser Notification" }].map(({ k, l }) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.dim}` }}>
            <span style={{ color: C.text, fontSize: 13 }}>{l}</span>
            <Toggle on={alerts[k]} onToggle={() => { if (k === "notification") requestNotifPerm(); setAlerts((p) => ({ ...p, [k]: !p[k] })); }} C={C} />
          </div>
        ))}
      </div>

      <div style={S.card}>
        <div style={{ color: C.text, fontWeight: 700, marginBottom: 8 }}>Refresh · <span style={{ color: C.green }}>{refresh}s</span></div>
        <input type="range" min={3} max={60} value={refresh} onChange={(e) => setRefresh(+e.target.value)} style={{ width: "100%", accentColor: C.green }} />
      </div>

      <div style={S.card}>
        <div style={{ color: C.text, fontWeight: 700, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}><Calculator size={14} /> Calculators</div>
        <div style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>Position Size (Risk / SL distance)</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 10 }}>
          <input type="number" placeholder="Risk ₹" value={calc.risk} onChange={(e) => setCalc((p) => ({ ...p, risk: +e.target.value }))} style={{ padding: 8, borderRadius: 6, background: C.dim, color: C.text, border: `1px solid ${C.border}` }} />
          <input type="number" placeholder="Entry" value={calc.entry} onChange={(e) => setCalc((p) => ({ ...p, entry: +e.target.value }))} style={{ padding: 8, borderRadius: 6, background: C.dim, color: C.text, border: `1px solid ${C.border}` }} />
          <input type="number" placeholder="SL" value={calc.sl} onChange={(e) => setCalc((p) => ({ ...p, sl: +e.target.value }))} style={{ padding: 8, borderRadius: 6, background: C.dim, color: C.text, border: `1px solid ${C.border}` }} />
        </div>
        <div style={{ color: C.green, fontWeight: 800, fontSize: 16, marginBottom: 12 }}>Qty: {posSize} units</div>

        <div style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>P&L Calculator</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
          <input type="number" placeholder="Exit" value={calc.exit} onChange={(e) => setCalc((p) => ({ ...p, exit: +e.target.value }))} style={{ padding: 8, borderRadius: 6, background: C.dim, color: C.text, border: `1px solid ${C.border}` }} />
        </div>
        <div style={{ color: pnlCalc >= 0 ? C.green : C.red, fontWeight: 800, fontSize: 16, marginBottom: 12 }}>P&L: ₹{fmt(pnlCalc, 0)}</div>

        <div style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>Risk:Reward</div>
        <input type="number" placeholder="Target" value={calc.target} onChange={(e) => setCalc((p) => ({ ...p, target: +e.target.value }))} style={{ width: "100%", padding: 8, borderRadius: 6, background: C.dim, color: C.text, border: `1px solid ${C.border}`, marginBottom: 8, boxSizing: "border-box" }} />
        <div style={{ color: C.yellow, fontWeight: 800, fontSize: 16 }}>R:R = 1:{rrCalc}</div>
      </div>
    </div>
  );

  const TABS = [
    { id: "dashboard", Icon: Home, label: "Home" },
    { id: "charts", Icon: BarChart2, label: "Charts" },
    { id: "portfolio", Icon: Briefcase, label: "Portfolio" },
    { id: "trades", Icon: Activity, label: "Trades" },
    { id: "news", Icon: Newspaper, label: "News" },
    { id: "watchlist", Icon: Star, label: "Watch" },
    { id: "settings", Icon: Settings, label: "Settings" },
  ];

  const CONTENT = { dashboard: Dashboard, charts: Charts, portfolio: PortfolioTab, trades: TradesTab, news: NewsTab, watchlist: WatchlistTab, settings: SettingsTab };
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

      <div style={{ paddingTop: 8 }}><ActiveTab /></div>

      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, margin: "0 auto", width: "100%", maxWidth: "min(100%, 960px)", background: C.card, borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-around", padding: "8px 0 max(12px, env(safe-area-inset-bottom))", zIndex: 50 }}>
        {TABS.map(({ id, Icon, label }) => (
          <button key={id} onClick={() => setTab(id)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "4px 4px", background: "none", border: "none", cursor: "pointer", minWidth: 0 }}>
            <Icon size={20} color={tab === id ? C.green : C.muted} />
            <span style={{ fontSize: 8, color: tab === id ? C.green : C.muted, fontWeight: tab === id ? 800 : 400 }}>{label}</span>
          </button>
        ))}
      </div>

      {chatOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", flexDirection: "column", background: C.bg }}>
          <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>⚡ AI Assistant</div>
              <div style={{ color: C.muted, fontSize: 10 }}>Powered by Claude</div>
            </div>
            <button onClick={() => setChatOpen(false)} style={{ background: C.dim, border: "none", color: C.muted, cursor: "pointer", borderRadius: 8, padding: 6 }}><X size={18} /></button>
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
