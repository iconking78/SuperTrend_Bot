         const https = require("https");
const fs    = require("fs");

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const WEBHOOK_URL    = process.env.WEBHOOK_URL || "https://supertrend-bot-64nr.onrender.com/webhook";
const ATR_PERIOD     = parseInt(process.env.ATR_PERIOD || "7");
const FACTOR         = parseFloat(process.env.FACTOR || "1.0");

// Multiple trading pairs
const SYMBOLS = [
  "XRP-USDC",
  "ADA-USDC",
  "PEPE-USDC",
  "XLM-USDC",
  "BONK-USDC",
];

const STATE_DIR = "/opt/render/project/src/";

function getStateFile(symbol) {
  return `${STATE_DIR}state_${symbol.replace("-", "_")}.json`;
}

function getLastAction(symbol) {
  try {
    const data = JSON.parse(fs.readFileSync(getStateFile(symbol), "utf8"));
    return data.lastAction || null;
  } catch(e) { return null; }
}

function saveLastAction(symbol, action) {
  try {
    fs.writeFileSync(getStateFile(symbol), JSON.stringify({ lastAction: action, time: new Date().toISOString() }));
  } catch(e) { console.error(`State save error [${symbol}]:`, e.message); }
}

function httpGet(hostname, path) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path, headers: { "User-Agent": "supertrend-bot" } }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
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

async function getCandles(symbol) {
  const end   = Math.floor(Date.now() / 1000);
  const start = end - (900 * 300);
  const path  = `/api/v3/brokerage/market/products/${symbol}/candles?start=${start}&end=${end}&granularity=FIFTEEN_MINUTE`;
  const data  = await httpGet("api.coinbase.com", path);
  return (data.candles || []).reverse();
}

function calcATR(candles, period) {
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const high  = parseFloat(candles[i].high);
    const low   = parseFloat(candles[i].low);
    const pClose= parseFloat(candles[i-1].close);
    tr.push(Math.max(high - low, Math.abs(high - pClose), Math.abs(low - pClose)));
  }
  const atr  = new Array(tr.length + 1).fill(0);
  const alpha = 1 / period;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += tr[i];
  atr[period] = seed / period;
  for (let i = period + 1; i < tr.length; i++) {
    atr[i] = atr[i-1] * (1 - alpha) + tr[i] * alpha;
  }
  return atr;
}

function calcSupertrend(candles, factor, period) {
  const atr        = calcATR(candles, period);
  const direction  = new Array(candles.length).fill(1);
  const supertrend = new Array(candles.length).fill(0);
  for (let i = period + 1; i < candles.length; i++) {
    const high  = parseFloat(candles[i].high);
    const low   = parseFloat(candles[i].low);
    const close = parseFloat(candles[i].close);
    const hl2   = (high + low) / 2;
    const upper = hl2 + factor * atr[i];
    const lower = hl2 - factor * atr[i];
    const prevST  = supertrend[i-1] || hl2;
    const prevDir = direction[i-1];
    if (prevDir === 1) {
      supertrend[i] = close < lower ? upper : Math.min(lower, prevST);
      direction[i]  = close < supertrend[i] ? 1 : -1;
    } else {
      supertrend[i] = close > upper ? lower : Math.max(upper, prevST);
      direction[i]  = close > supertrend[i] ? -1 : 1;
    }
  }
  return { direction, supertrend };
}

async function checkSymbol(symbol) {
  try {
    const candles = await getCandles(symbol);
    if (candles.length < ATR_PERIOD + 2) return;

    const { direction } = calcSupertrend(candles, FACTOR, ATR_PERIOD);
    const len   = direction.length;
    const prev  = direction[len - 2];
    const curr  = direction[len - 1];
    const close = parseFloat(candles[len - 1].close);
    const time  = new Date().toISOString();
    const lastAction = getLastAction(symbol);

    console.log(`[${symbol}] $${close} | dir: ${prev}→${curr} | last: ${lastAction || "none"}`);

    const isBuyFlip  = prev > 0 && curr < 0;
    const isSellFlip = prev < 0 && curr > 0;

    if (isBuyFlip && lastAction !== "buy") {
      console.log(`[${symbol}] BUY signal!`);
      saveLastAction(symbol, "buy");
      await httpPost(WEBHOOK_URL, { action: "buy", symbol: symbol.replace("-", ""), price: close, time, secret: WEBHOOK_SECRET });
    } else if (isSellFlip && lastAction !== "sell") {
      console.log(`[${symbol}] SELL signal!`);
      saveLastAction(symbol, "sell");
      await httpPost(WEBHOOK_URL, { action: "sell", symbol: symbol.replace("-", ""), price: close, time, secret: WEBHOOK_SECRET });
    } else {
      console.log(`[${symbol}] Holding — no flip`);
    }
  } catch (err) {
    console.error(`[${symbol}] Error:`, err.message);
  }
}

async function checkAllSymbols() {
  console.log(`\n--- Checking ${SYMBOLS.length} pairs [${new Date().toISOString()}] ---`);
  for (const symbol of SYMBOLS) {
    await checkSymbol(symbol);
    await new Promise(r => setTimeout(r, 500)); // small delay between calls
  }
}

checkAllSymbols();
setInterval(checkAllSymbols, 5 * 60 * 1000);
console.log(`Multi-pair signal checker running | ${SYMBOLS.join(", ")} | ATR:${ATR_PERIOD} Factor:${FACTOR}`);
