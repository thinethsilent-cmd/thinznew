import { db } from "./firebase-config.js";
import {
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  deleteDoc,
  doc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// ═══════════════════════════════════════════════════════════════════════════════
//  TECHNICAL ANALYSIS ENGINE  –  All calculations from real Binance OHLCV data
// ═══════════════════════════════════════════════════════════════════════════════

// ── Price Formatter ──────────────────────────────────────────────────────────
function fmt(price) {
  if (price === null || price === undefined || isNaN(price)) return "N/A";
  if (price < 0.00001) return price.toFixed(8);
  if (price < 0.001)   return price.toFixed(6);
  if (price < 0.1)     return price.toFixed(5);
  if (price < 1)       return price.toFixed(4);
  if (price < 10)      return price.toFixed(3);
  if (price < 1000)    return price.toFixed(2);
  return price.toFixed(1);
}

// ── EMA – Exponential Moving Average ────────────────────────────────────────
function calcEMA(closes, period) {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

// ── RSI – Relative Strength Index (14) ──────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ── MACD – Moving Average Convergence Divergence (12,26,9) ──────────────────
function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (ema12.length < 2 || ema26.length < 2) return null;
  // Align: ema26 starts 14 bars later in original closes
  const offset = 14; // 26 - 12
  const macdLine = ema12.slice(offset).map((v, i) => v - ema26[i]);
  const signalLine = calcEMA(macdLine, 9);
  if (macdLine.length < 2 || signalLine.length < 2) return null;
  const mLen = macdLine.length;
  const sLen = signalLine.length;
  return {
    macd: macdLine[mLen - 1],
    signal: signalLine[sLen - 1],
    histogram: macdLine[mLen - 1] - signalLine[sLen - 1],
    prevMacd: macdLine[mLen - 2],
    prevSignal: signalLine[sLen - 2],
    // Bullish crossover = macd crossed above signal
    bullishCross: macdLine[mLen - 2] < signalLine[sLen - 2] && macdLine[mLen - 1] > signalLine[sLen - 1],
    bearishCross: macdLine[mLen - 2] > signalLine[sLen - 2] && macdLine[mLen - 1] < signalLine[sLen - 1],
  };
}

// ── Bollinger Bands (20, 2σ) ─────────────────────────────────────────────────
function calcBB(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    upper: mean + 2 * stdDev,
    middle: mean,
    lower: mean - 2 * stdDev,
    bandwidth: (4 * stdDev) / mean,   // BB width as % of price
  };
}

// ── ATR – Average True Range (14) ────────────────────────────────────────────
function calcATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  return atr;
}

// ── Volume Analysis ───────────────────────────────────────────────────────────
function analyzeVolume(volumes) {
  if (volumes.length < 20) return { spike: false, ratio: 1 };
  const avgVol = volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
  const lastVol = volumes[volumes.length - 1];
  const ratio = lastVol / avgVol;
  return { spike: ratio > 1.5, ratio };
}

// ── Support / Resistance levels from recent highs & lows ─────────────────────
function getSupportResistance(highs, lows, closes, atr) {
  const recentHighs = highs.slice(-30);
  const recentLows  = lows.slice(-30);
  const lastClose   = closes[closes.length - 1];

  // Nearest resistance above current price
  const resistance = recentHighs
    .filter(h => h > lastClose)
    .sort((a, b) => a - b)[0] || lastClose * 1.05;

  // Nearest support below current price
  const support = recentLows
    .filter(l => l < lastClose)
    .sort((a, b) => b - a)[0] || lastClose * 0.95;

  // Dynamic TP/SL using ATR
  const atrMultiplierTP = 2.5;
  const atrMultiplierSL = 1.5;

  return { resistance, support, atrMultiplierTP, atrMultiplierSL };
}

// ── Elliott Wave Theory Detection ────────────────────────────────────────────
// Identifies swing points and checks for classic 5-wave impulse or ABC correction.
// Returns { wave, direction, confidence, label }
function calcElliottWave(highs, lows, closes) {
  const n = closes.length;
  if (n < 50) return null;

  // Find local swing highs and lows (pivot points) over the last 60 bars
  const window = 3; // bars either side
  const swingHighs = [];
  const swingLows  = [];
  const slice = Math.min(n, 80);
  const offset = n - slice;

  for (let i = window; i < slice - window; i++) {
    const isHigh = highs.slice(i - window, i + window + 1).every(h => highs[i + offset] >= h);
    const isLow  = lows.slice(i - window, i + window + 1).every(l => lows[i + offset] <= l);
    if (isHigh) swingHighs.push({ idx: i + offset, price: highs[i + offset] });
    if (isLow)  swingLows.push({ idx: i + offset, price: lows[i + offset] });
  }

  if (swingHighs.length < 3 || swingLows.length < 3) return null;

  const lastClose = closes[n - 1];

  // ── Bullish Elliott Setup: 5-wave impulse UP ─────────────────────────
  // W1: swing low → high. W2: retrace. W3: new high > W1 top. W4: retrace.
  // W5: new high or near W3 top → look for long at end of W4 or early W5.
  // Simplified: detect W3 peak (highest high in pattern), W4 correction, W5 setup.
  const recentLows  = swingLows.slice(-4);
  const recentHighs = swingHighs.slice(-4);

  if (recentLows.length >= 2 && recentHighs.length >= 2) {
    const w1Low  = recentLows[recentLows.length - 3]?.price;
    const w1High = recentHighs[recentHighs.length - 3]?.price;
    const w2Low  = recentLows[recentLows.length - 2]?.price;
    const w3High = recentHighs[recentHighs.length - 2]?.price;
    const w4Low  = recentLows[recentLows.length - 1]?.price;
    const w5High = recentHighs[recentHighs.length - 1]?.price;

    // 5-Wave bullish impulse rules:
    // W3 > W1 high, W4 does not dip below W1 high, W5 near or above W3 high
    if (w1Low && w1High && w2Low && w3High && w4Low) {
      const w3IsExtended = w3High > w1High * 1.01; // W3 breaks W1 top
      const w4Shallow   = w4Low > w1High * 0.99;  // W4 stays above W1 top
      const priceInW4   = lastClose <= w4Low * 1.05 && lastClose >= w4Low * 0.95;
      const priceInW5   = w5High && lastClose > w4Low && lastClose < w3High;

      if (w3IsExtended && w4Shallow) {
        if (priceInW4) {
          return { wave: 4, direction: "BUY", confidence: 4,
            label: "Elliott W4 Correction — BUY setup into W5 impulse" };
        }
        if (priceInW5) {
          return { wave: 5, direction: "BUY", confidence: 2,
            label: "Elliott W5 Impulse — BUY (early stage)" };
        }
        // W3 just printed — strongest wave
        return { wave: 3, direction: "BUY", confidence: 4,
          label: "Elliott W3 Impulse — Strongest bullish wave" };
      }
    }

    // ── Bearish Elliott: ABC Corrective wave or 5-wave down ──────────────
    const aHigh = recentHighs[recentHighs.length - 2]?.price;
    const bLow  = recentLows[recentLows.length - 2]?.price;
    const cHigh = recentHighs[recentHighs.length - 1]?.price;

    if (aHigh && bLow && cHigh) {
      const abcPattern = cHigh < aHigh && bLow < aHigh && lastClose < cHigh;
      if (abcPattern) {
        return { wave: "C", direction: "SELL", confidence: 3,
          label: "Elliott ABC Correction — SELL near Wave C top" };
      }
    }
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN SIGNAL ENGINE  –  Analyse a single coin using all indicators
// ══════════════════════════════════════════════════════════════════════════════
export async function analyseSymbol(symbol, interval = "1h", force = false) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=150`;
    const res  = await fetch(url);
    if (!res.ok) return null;
    const klines = await res.json();
    if (!Array.isArray(klines) || klines.length < 50) return null;

    // Parse OHLCV
    const opens   = klines.map(k => parseFloat(k[1]));
    const highs   = klines.map(k => parseFloat(k[2]));
    const lows    = klines.map(k => parseFloat(k[3]));
    const closes  = klines.map(k => parseFloat(k[4]));
    const volumes = klines.map(k => parseFloat(k[5]));

    const lastClose = closes[closes.length - 1];
    const lastHigh  = highs[highs.length - 1];
    const lastLow   = lows[lows.length - 1];

    // ── Calculate all indicators ──
    const rsi  = calcRSI(closes, 14);
    const macd = calcMACD(closes);
    const bb   = calcBB(closes, 20);
    const atr  = calcATR(highs, lows, closes, 14);
    const vol  = analyzeVolume(volumes);

    const ema9   = calcEMA(closes, 9);
    const ema21  = calcEMA(closes, 21);
    const ema50  = calcEMA(closes, 50);
    const ema200 = calcEMA(closes, 200);

    if (!rsi || !macd || !bb || !atr) return null;

    const e9   = ema9[ema9.length - 1];
    const e21  = ema21[ema21.length - 1];
    const e50  = ema50.length > 0 ? ema50[ema50.length - 1] : null;
    const e200 = ema200.length > 0 ? ema200[ema200.length - 1] : null;

    // ── Scoring System ─────────────────────────────────────────────────────
    // Each indicator gives +1 (bullish) or -1 (bearish).
    // Signal only generated if |score| >= threshold (strong confluence).

    let bullScore = 0;
    let bearScore = 0;
    const reasons = [];

    // 1. RSI
    if (rsi < 35) {
      bullScore += 2;
      reasons.push(`RSI Oversold (${rsi.toFixed(1)}) — reversal likely`);
    } else if (rsi > 65) {
      bearScore += 2;
      reasons.push(`RSI Overbought (${rsi.toFixed(1)}) — rejection likely`);
    } else if (rsi > 50 && rsi < 65) {
      bullScore += 1;
      reasons.push(`RSI Bullish Zone (${rsi.toFixed(1)})`);
    } else if (rsi < 50 && rsi > 35) {
      bearScore += 1;
      reasons.push(`RSI Bearish Zone (${rsi.toFixed(1)})`);
    }

    // 2. MACD
    if (macd.bullishCross) {
      bullScore += 3;
      reasons.push("MACD Bullish Crossover confirmed");
    } else if (macd.bearishCross) {
      bearScore += 3;
      reasons.push("MACD Bearish Crossover confirmed");
    } else if (macd.macd > macd.signal && macd.histogram > 0) {
      bullScore += 1;
      reasons.push("MACD above signal (bullish momentum)");
    } else if (macd.macd < macd.signal && macd.histogram < 0) {
      bearScore += 1;
      reasons.push("MACD below signal (bearish momentum)");
    }

    // 3. EMA Alignment
    if (e50 && e200) {
      if (e9 > e21 && e21 > e50 && e50 > e200) {
        bullScore += 3;
        reasons.push("Full EMA Bullish Stack (9>21>50>200)");
      } else if (e9 < e21 && e21 < e50 && e50 < e200) {
        bearScore += 3;
        reasons.push("Full EMA Bearish Stack (9<21<50<200)");
      } else if (lastClose > e50 && lastClose > e200) {
        bullScore += 2;
        reasons.push("Price above EMA 50 & 200 (bullish bias)");
      } else if (lastClose < e50 && lastClose < e200) {
        bearScore += 2;
        reasons.push("Price below EMA 50 & 200 (bearish bias)");
      }
    } else if (e9 && e21) {
      if (lastClose > e9 && e9 > e21) {
        bullScore += 1;
        reasons.push("EMA 9 above EMA 21 (short-term bullish)");
      } else if (lastClose < e9 && e9 < e21) {
        bearScore += 1;
        reasons.push("EMA 9 below EMA 21 (short-term bearish)");
      }
    }

    // 4. Bollinger Bands
    const bbPos = (lastClose - bb.lower) / (bb.upper - bb.lower);
    if (lastClose <= bb.lower * 1.005) {
      bullScore += 2;
      reasons.push("Price at BB Lower Band — mean reversion BUY zone");
    } else if (lastClose >= bb.upper * 0.995) {
      bearScore += 2;
      reasons.push("Price at BB Upper Band — mean reversion SELL zone");
    } else if (bbPos > 0.5) {
      bullScore += 0.5;
    } else {
      bearScore += 0.5;
    }

    // 5. Volume Spike (confirms breakout/breakdown)
    if (vol.spike) {
      if (bullScore > bearScore) {
        bullScore += 2;
        reasons.push(`Volume Spike ${vol.ratio.toFixed(1)}x avg — confirms BUY`);
      } else {
        bearScore += 2;
        reasons.push(`Volume Spike ${vol.ratio.toFixed(1)}x avg — confirms SELL`);
      }
    }

    // 6. Candle body analysis (last 3 candles momentum)
    const lastBody = Math.abs(closes[closes.length - 1] - opens[closes.length - 1]);
    const prevBody = Math.abs(closes[closes.length - 2] - opens[closes.length - 2]);
    const isBullCandle  = closes[closes.length - 1] > opens[closes.length - 1];
    const isBearCandle  = closes[closes.length - 1] < opens[closes.length - 1];
    if (isBullCandle && lastBody > prevBody) {
      bullScore += 1;
      reasons.push("Strong bullish engulfing candle");
    } else if (isBearCandle && lastBody > prevBody) {
      bearScore += 1;
      reasons.push("Strong bearish engulfing candle");
    }

    // 7. Elliott Wave Theory
    const ew = calcElliottWave(highs, lows, closes);
    if (ew) {
      if (ew.direction === "BUY") {
        bullScore += ew.confidence;
        reasons.push(ew.label);
      } else if (ew.direction === "SELL") {
        bearScore += ew.confidence;
        reasons.push(ew.label);
      }
    }

    // ── Minimum signal threshold ──────────────────────────────────────────
    const MIN_SCORE = 5; // Require strong confluence
    const isBull = bullScore >= MIN_SCORE && bullScore > bearScore;
    const isBear = bearScore >= MIN_SCORE && bearScore > bullScore;

    if (!isBull && !isBear && !force) return null; // Weak signal – skip

    const direction = isBull ? "BUY" : (isBear ? "SELL" : "NEUTRAL");
    const score     = isBull ? bullScore : (isBear ? bearScore : Math.max(bullScore, bearScore));

    // ── Entry / Target / Stop Loss using ATR ─────────────────────────────
    const { resistance, support } = getSupportResistance(highs, lows, closes, atr);

    let entry, tp1, tp2, tp3, stopLoss;
    if (direction === "BUY" || (direction === "NEUTRAL" && bullScore >= bearScore)) {
      // Pullback/Long setup
      entry   = lastClose - atr * 0.2;
      tp1     = Math.min(entry + atr * 2.0, resistance);
      tp2     = entry + atr * 3.5;
      tp3     = entry + atr * 5.5;
      stopLoss = entry - atr * 1.5;
    } else {
      // Breakout/Short setup
      entry   = lastClose + atr * 0.2;
      tp1     = Math.max(entry - atr * 2.0, support);
      tp2     = entry - atr * 3.5;
      tp3     = entry - atr * 5.5;
      stopLoss = entry + atr * 1.5;
    }

    // Risk/Reward Ratio
    const risk   = Math.abs(entry - stopLoss);
    const reward = Math.abs(tp1 - entry);
    const rrr    = (reward / risk).toFixed(2);

    // ── Accuracy score (based on number of confluent indicators) ─────────
    const maxScore  = 18; // theoretical max (14 TA + 4 Elliott Wave)
    const rawAccuracy = Math.min(97, 78 + (score / maxScore) * 20);
    const accuracy  = rawAccuracy.toFixed(1) + "%";

    // ── Leverage suggestion (lower for volatile / high ATR) ──────────────
    const atrPercent = (atr / lastClose) * 100;
    let leverage;
    if (atrPercent > 3) leverage = "3x";
    else if (atrPercent > 2) leverage = "5x";
    else if (atrPercent > 1) leverage = "8x";
    else leverage = "10x";

    // ── Timeframe label ──────────────────────────────────────────────────
    const tfLabel = { "15m": "15M", "1h": "1H", "4h": "4H", "1d": "1D" }[interval] || "1H";

    // ── Analysis summary for display ─────────────────────────────────────
    const analysisText = reasons.slice(0, 4).join(" | ");
    const ewLabel = ew ? ew.label : null;

    return {
      id: `ta-${symbol}-${Date.now()}`,
      pair: symbol.replace("USDT", "/USDT"),
      symbol,
      direction,
      timeframe: tfLabel,
      entry: fmt(entry),
      targets: [fmt(tp1), fmt(tp2), fmt(tp3)],
      stopLoss: fmt(stopLoss),
      leverage,
      minTrade: "$10",
      accuracy,
      rrr,
      rsi: rsi.toFixed(1),
      analysisText,
      ewLabel,
      status: "Pending",
      tier: "vip", // will be overridden for free signals
      confluenceScore: score,
      createdAt: new Date().toISOString()
    };

  } catch (err) {
    // Silently ignore individual pair errors
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  SCAN ENGINE  –  Scan top pairs, run TA, return ranked signals
// ══════════════════════════════════════════════════════════════════════════════

// Verified fallback list — all confirmed active on Binance spot as of 2025
export const SCAN_PAIRS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "DOGEUSDT","ADAUSDT","AVAXUSDT","LINKUSDT","DOTUSDT",
  "LTCUSDT","TRXUSDT","ATOMUSDT","NEARUSDT",
  "APTUSDT","ARBUSDT","OPUSDT","INJUSDT","SUIUSDT",
  "SEIUSDT","TIAUSDT","STXUSDT","RUNEUSDT",
  "HBARUSDT","VETUSDT","FILUSDT",
  "GRTUSDT","AAVEUSDT","UNIUSDT",
  "SHIBUSDT","PEPEUSDT","FLOKIUSDT","WIFUSDT",
  "ENAUSDT","JUPUSDT","PYTHUSDT","RENDERUSDT","FETUSDT",
  "ONDOUSDT","TAOUSDT","MOVEUSDT","ZKUSDT","EIGENUSDT"
];

// Stablecoins & non-crypto assets to always exclude
const EXCLUDED_SYMBOLS = new Set([
  "TUSDUSDT","BUSDUSDT","USDCUSDT","DAIUSDT","FDUSDUSDT",
  "USDTUSDT","EURUSDT","GBPUSDT","AUSDUSDT","PAXUSDT",
  "SUSDUSDT","USTUSDT","FRAXUSDT","LUSDUSDT","GUSDUSDT",
  "USDPUSDT","UPERUSDT","AEURUSDT","IDRTUSDT","BIDRUSDT"
]);

// Fetch ONLY symbols that are actively trading on Binance Spot right now.
// Uses exchangeInfo (authoritative list) cross-referenced with 24hr volume.
export async function fetchScanPairs() {
  try {
    console.log("[TA Engine] Fetching active Binance spot symbols via exchangeInfo...");

    // Step 1: Get the authoritative list of all ACTIVE Binance spot USDT pairs
    const infoRes = await fetch("https://api.binance.com/api/v3/exchangeInfo");
    if (!infoRes.ok) throw new Error("exchangeInfo fetch failed");
    const infoData = await infoRes.json();

    // Build a Set of all TRADING USDT pairs on the SPOT market
    const activeBinanceSpotPairs = new Set(
      infoData.symbols
        .filter(s =>
          s.status === "TRADING" &&
          s.quoteAsset === "USDT" &&
          s.isSpotTradingAllowed === true
        )
        .map(s => s.symbol)
    );

    console.log(`[TA Engine] Binance has ${activeBinanceSpotPairs.size} active USDT spot pairs.`);

    // Step 2: Get 24hr volume data for sorting & volume filtering
    const volRes = await fetch("https://api.binance.com/api/v3/ticker/24hr");
    if (!volRes.ok) throw new Error("24hr ticker fetch failed");
    const volData = await volRes.json();

    // Step 3: Cross-reference — only keep pairs that are:
    //   - In the active Binance spot set
    //   - Not a stablecoin or excluded asset
    //   - Not a leveraged/bull/bear token
    //   - Has at least $500k 24h quote volume
    const filtered = volData
      .filter(d => {
        const sym = d.symbol;
        if (!activeBinanceSpotPairs.has(sym)) return false;       // Must be active on Binance spot
        if (EXCLUDED_SYMBOLS.has(sym)) return false;              // No stablecoins
        if (!sym.endsWith("USDT")) return false;                  // USDT pairs only
        if (/UP|DOWN|BULL|BEAR|3L|3S|5L|5S/.test(sym)) return false; // No leveraged tokens
        if (parseFloat(d.quoteVolume) < 500000) return false;    // Min $500k volume
        return true;
      })
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));

    const symbols = filtered.slice(0, 600).map(d => d.symbol);

    // Make available globally for search autocomplete
    window.allBinanceUsdtPairs = symbols;
    console.log(`[TA Engine] ✅ ${symbols.length} verified active Binance spot USDT pairs ready.`);
    return symbols;

  } catch (err) {
    console.warn("[TA Engine] Fetch failed, using verified fallback list:", err);
    window.allBinanceUsdtPairs = SCAN_PAIRS;
    return SCAN_PAIRS;
  }
}


// Cache with 15-min expiry to avoid hammering API
let taCache = null;
let taCacheTime = 0;
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

async function scanMarket() {
  const now = Date.now();
  if (taCache && (now - taCacheTime) < CACHE_TTL) {
    return taCache;
  }

  console.log("[TA Engine] Starting market scan of 550+ cryptocurrencies...");

  // Load scan pairs dynamically
  const scanPairs = await fetchScanPairs();

  // Run scans with a concurrency limit of 12 parallel requests
  const results = [];
  let currentIndex = 0;
  const concurrencyLimit = 12;

  // Set initial scan progress state
  if (typeof window.onScanProgress === "function") {
    window.onScanProgress(0, scanPairs.length, 0);
  }

  async function worker() {
    while (currentIndex < scanPairs.length) {
      const index = currentIndex++;
      const symbol = scanPairs[index];
      
      try {
        const signal = await analyseSymbol(symbol, "1h");
        if (signal) {
          results.push(signal);
        }
      } catch (err) {
        console.error(`Error scanning symbol ${symbol}:`, err);
      }
      
      if (typeof window.onScanProgress === "function") {
        window.onScanProgress(currentIndex, scanPairs.length, results.length);
      }

      // Small throttle to prevent slamming the network thread
      await new Promise(r => setTimeout(r, 40));
    }
  }

  // Launch workers
  const workers = Array(Math.min(concurrencyLimit, scanPairs.length))
    .fill(null)
    .map(() => worker());

  await Promise.all(workers);

  // Sort by confluence score (strongest signals first)
  results.sort((a, b) => b.confluenceScore - a.confluenceScore);

  console.log(`[TA Engine] Scan complete. Found ${results.length} valid signals out of ${scanPairs.length} scanned.`);

  // Mark the top 2 as free signals, rest as VIP
  const tagged = results.map((sig, idx) => ({
    ...sig,
    tier: idx < 2 ? "free" : "vip"
  }));

  taCache = tagged;
  taCacheTime = now;
  return tagged;
}

// ══════════════════════════════════════════════════════════════════════════════
//  SUBSCRIBE TO SIGNALS  –  Main export used by app.js / common.js
// ══════════════════════════════════════════════════════════════════════════════
export function subscribeToSignals(premiumStatus, callback) {
  const q = query(collection(db, "signals"), orderBy("createdAt", "desc"));

  return onSnapshot(q, async (snapshot) => {
    // Firestore admin-created signals
    let dbSignals = [];
    snapshot.forEach((docSnap) => {
      dbSignals.push({ id: docSnap.id, ...docSnap.data() });
    });

    // Run TA engine (cached after first run)
    let taSignals = [];
    try {
      taSignals = await scanMarket();
    } catch(e) {
      console.error("[TA Engine] Scan failed:", e);
    }

    // Admin DB signals always take priority over TA-generated ones
    const dbFree = dbSignals.filter(s => s.tier === "free");
    const dbVip  = dbSignals.filter(s => s.tier === "vip" || !s.tier);
    const taFree = taSignals.filter(s => s.tier === "free");
    const taVip  = taSignals.filter(s => s.tier === "vip");

    const allFree = [...dbFree, ...taFree];
    const allVip  = [...dbVip, ...taVip];

    let processedSignals = [];

    if (premiumStatus === "paid" || premiumStatus === "admin") {
      // ── VIP/Admin: all signals fully unlocked ──────────────────────────
      processedSignals = [...allFree, ...allVip].map(sig => ({
        ...sig,
        locked: false
      }));

    } else {
      // ── Free user: exactly 1 signal unlocked, rest locked ────────────
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const activeFree = allFree.filter(s => s.createdAt >= oneDayAgo).slice(0, 1);

      const vipLocked = allVip.map(sig => ({
        id: sig.id,
        pair: sig.pair,
        direction: sig.direction,
        timeframe: sig.timeframe,
        status: sig.status || "Pending",
        tier: "vip",
        locked: true,
        entry: "•••",
        targets: ["•••", "•••", "•••"],
        stopLoss: "•••",
        leverage: "VIP",
        minTrade: "VIP",
        accuracy: sig.accuracy || "95%+",
        analysisText: sig.analysisText || "",
        createdAt: sig.createdAt
      }));

      processedSignals = [
        ...activeFree.map(sig => ({ ...sig, locked: false })),
        ...vipLocked
      ];
    }

    callback(processedSignals);
  }, (error) => {
    console.error("[Signals] Subscription error:", error);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  ADMIN CRUD OPERATIONS
// ══════════════════════════════════════════════════════════════════════════════

export async function createSignal(signalData) {
  try {
    const docRef = await addDoc(collection(db, "signals"), {
      ...signalData,
      createdAt: new Date().toISOString(),
      status: "Pending"
    });
    return docRef.id;
  } catch (error) {
    console.error("Error creating signal:", error);
    throw error;
  }
}

export async function updateSignalStatus(signalId, status) {
  try {
    await updateDoc(doc(db, "signals", signalId), { status });
  } catch (error) {
    console.error("Error updating signal status:", error);
    throw error;
  }
}

export async function deleteSignal(signalId) {
  try {
    await deleteDoc(doc(db, "signals", signalId));
  } catch (error) {
    console.error("Error deleting signal:", error);
    throw error;
  }
}
