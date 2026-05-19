const https = require("https");
const crypto = require("crypto");

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const WEBHOOK_URL    = process.env.WEBHOOK_URL || "https://supertrend-bot-64nr.onrender.com/webhook";
const SYMBOL         = process.env.SYMBOL || "XRP-USD";
const INTERVAL       = process.env.INTERVAL || "900"; // 15 min in seconds
const ATR_PERIOD     = parseInt(process.env.ATR_PERIOD || "7");
const FACTOR         = parseFloat(process.env.FACTOR || "1.0");

// ─── HTTP helper ─────────────────────────────────────────────────────────────
function httpGet(hostname, path) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path, headers: { "User-Agent": "supertrend-bot" } }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on("error", reject);
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Fetch OHLCV candles from Coinbase ───────────────────────────────────────
async function getCandles() {
  const end   = Math.floor(Date.now() / 1000);
  const start = end - (INTERVAL * 300); // ~300 candles
  const path  = `/api/v3/brokerage/market/products/${SYMBOL}/candles?start=${start}&end=${end}&granularity=FIFTEEN_MINUTE`;
  const data  = await httpGet("api.coinbase.com", path);
  // candles: [start, low, high, open, close, volume]
  const candles = (data.candles || []).reverse(); // oldest first
  return candles;
}

// ─── ATR calculation ──────────────────────────────────────────────────────────
function calcATR(candles, period) {
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const high  = parseFloat(candles[i].high);
    const low   = parseFloat(candles[i].low);
    const pClose= parseFloat(candles[i-1].close);
    tr.push(Math.max(high - low, Math.abs(high - pClose), Math.abs(low - pClose)));
  }
  // RMA (Wilder's smoothing) like Pine Script
  const atr = [0];
  const alpha = 1 / period;
  // seed with SMA
  let seed = 0;
  for (let i = 0; i < period; i++) seed += tr[i];
  atr[period] = seed / period;
  for (let i = period + 1; i < tr.length; i++) {
    atr[i] = atr[i-1] * (1 - alpha) + tr[i] * alpha;
  }
  return atr;
}

// ─── Supertrend calculation ───────────────────────────────────────────────────
function calcSupertrend(candles, factor, period) {
  const atr = calcATR(candles, period);
  const direction = new Array(candles.length).fill(1);
  const supertrend = new Array(candles.length).fill(0);

  for (let i = period + 1; i < candles.length; i++) {
    const high  = parseFloat(candles[i].high);
    const low   = parseFloat(candles[i].low);
    const close = parseFloat(candles[i].close);
    const hl2   = (high + low) / 2;

    const upperBand = hl2 + factor * atr[i];
    const lowerBand = hl2 - factor * atr[i];

    const prevST  = supertrend[i-1] || hl2;
    const prevDir = direction[i-1];

    if (prevDir === 1) {
      supertrend[i] = close < lowerBand ? upperBand : Math.min(lowerBand, prevST);
      direction[i]  = close < supertrend[i] ? 1 : -1;
    } else {
      supertrend[i] = close > upperBand ? lowerBand : Math.max(upperBand, prevST);
      direction[i]  = close > supertrend[i] ? -1 : 1;
    }
  }

  return { direction, supertrend };
}

// ─── State to track last signal sent ─────────────────────────────────────────
let lastSignal = null;

// ─── Main check loop ──────────────────────────────────────────────────────────
async function checkSignal() {
  try {
    const candles = await getCandles();
    if (candles.length < ATR_PERIOD + 2) {
      console.log("Not enough candles yet");
      return;
    }

    const { direction } = calcSupertrend(candles, FACTOR, ATR_PERIOD);
    const len  = direction.length;
    const prev = direction[len - 2];
    const curr = direction[len - 1];
    const close = parseFloat(candles[len - 1].close);
    const time  = new Date().toISOString();

    console.log(`[${time}] ${SYMBOL} close: ${close} | dir: ${prev} → ${curr}`);

    // Long condition: direction flipped from positive to negative
    if (prev > 0 && curr < 0 && lastSignal !== "buy") {
      console.log("BUY signal detected!");
      lastSignal = "buy";
      await httpPost(WEBHOOK_URL, {
        action: "buy", symbol: SYMBOL.replace("-", ""),
        price: close, time, secret: WEBHOOK_SECRET,
      });
    }

    // Exit condition: direction flipped from negative to positive
    if (prev < 0 && curr > 0 && lastSignal !== "sell") {
      console.log("SELL signal detected!");
      lastSignal = "sell";
      await httpPost(WEBHOOK_URL, {
        action: "sell", symbol: SYMBOL.replace("-", ""),
        price: close, time, secret: WEBHOOK_SECRET,
      });
    }

  } catch (err) {
    console.error("Signal check error:", err.message);
  }
}

// Run immediately then every 5 minutes
checkSignal();
setInterval(checkSignal, 5 * 60 * 1000);
console.log(`Supertrend signal checker running | ${SYMBOL} | ATR:${ATR_PERIOD} Factor:${FACTOR}`);
