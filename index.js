      const express = require("express");
const https   = require("https");
const { CBAdvancedTradeClient } = require("coinbase-api");

const app = express();
app.use(express.json());

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const TG_TOKEN       = process.env.TELEGRAM_TOKEN || "";
const TG_CHAT_ID     = process.env.TELEGRAM_CHAT_ID || "";
const TRADE_SIZE_USD = process.env.TRADE_SIZE_USD || "7.37";

// Init Coinbase SDK — handles all auth automatically
const client = new CBAdvancedTradeClient({
  apiKey:    process.env.COINBASE_API_KEY,
  apiSecret: process.env.COINBASE_API_SECRET,
});

// ─── Telegram ─────────────────────────────────────────────────────────────────
function sendTelegram(message) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  const bodyStr = JSON.stringify({ chat_id: TG_CHAT_ID, text: message, parse_mode: "HTML" });
  const req = https.request({
    hostname: "api.telegram.org",
    path: `/bot${TG_TOKEN}/sendMessage`,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) },
  }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => console.log("Telegram:", d)); });
  req.on("error", e => console.error("Telegram error:", e.message));
  req.write(bodyStr);
  req.end();
}

// ─── Get USDC balance ─────────────────────────────────────────────────────────
async function getUSDCBalance() {
  try {
    const result = await client.getAccounts({ limit: 250 });
    const accounts = result?.accounts || [];
    const acc = accounts.find(a => a.currency === "USDC");
    console.log("USDC account:", JSON.stringify(acc));
    return parseFloat(acc?.available_balance?.value || TRADE_SIZE_USD);
  } catch(e) {
    console.error("Balance fetch error:", e.message);
    return parseFloat(TRADE_SIZE_USD) * 20; // fallback so 5% = TRADE_SIZE_USD
  }
}

// ─── Get XRP balance ──────────────────────────────────────────────────────────
async function getXRPBalance() {
  try {
    const result = await client.getAccounts({ limit: 250 });
    const accounts = result?.accounts || [];
    const acc = accounts.find(a => a.currency === "XRP");
    return parseFloat(acc?.available_balance?.value || "0");
  } catch(e) {
    console.error("XRP balance error:", e.message);
    return 0;
  }
}

// ─── Place order ──────────────────────────────────────────────────────────────
async function placeOrder(productId, side, sizeConfig) {
  return client.submitOrder({
    client_order_id: `supertrend-${Date.now()}`,
    product_id: productId,
    side: side.toUpperCase(),
    order_configuration: { market_market_ioc: sizeConfig },
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.sendFile(__dirname + "/dashboard.html"));
app.get("/health", (req, res) => res.send("Supertrend bot is live ✅"));

app.get("/test", async (req, res) => {
  try {
    const usdc = await getUSDCBalance();
    const xrp  = await getXRPBalance();
    res.json({ status: "ok", usdc_balance: usdc, xrp_balance: xrp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// Manual state control — /setstate?symbol=XRP-USDC&action=buy
app.get("/setstate", (req, res) => {
  const { action, symbol } = req.query;
  if (!["buy", "sell", "none"].includes(action)) {
    return res.status(400).json({ error: "action must be buy, sell, or none" });
  }
  const fs       = require("fs");
  const sym      = symbol || "XRP-USDC";
  const STATE_FILE = `/opt/render/project/src/state_${sym.replace("-", "_")}.json`;
  if (action === "none") {
    try { fs.unlinkSync(STATE_FILE); } catch(e) {}
    return res.json({ status: "ok", symbol: sym, lastAction: "none", message: "State cleared" });
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastAction: action, time: new Date().toISOString() }));
  res.json({ status: "ok", symbol: sym, lastAction: action, message: `${sym} state set to ${action}` });
});

// Status — shows all pairs
app.get("/status", (req, res) => {
  const fs      = require("fs");
  const SYMBOLS = ["XRP-USDC", "ADA-USDC", "PEPE-USDC", "XLM-USDC", "BONK-USDC"];
  const pairs   = SYMBOLS.map(sym => {
    const f = `/opt/render/project/src/state_${sym.replace("-", "_")}.json`;
    let state = { lastAction: "none", time: "unknown" };
    try { state = JSON.parse(fs.readFileSync(f, "utf8")); } catch(e) {}
    return { symbol: sym, lastAction: state.lastAction || "none", lastActionTime: state.time || "unknown" };
  });
  res.json({
    status: "live",
    uptime: process.uptime() + "s",
    tradeSize: "dynamic 5% per signal",
    pairs,
  });
});

app.post("/webhook", async (req, res) => {
  try {
    const { action, symbol, secret, price, time } = req.body;
    if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
    if (!action || !symbol) return res.status(400).json({ error: "Missing action or symbol" });

    const productId = symbol.includes("-") ? symbol : symbol.replace(/([A-Z]+)(USDC|USD|BTC|ETH)$/, "$1-$2");
    console.log(`Signal: ${action.toUpperCase()} ${productId} @ ${price}`);

    let result;

    if (action === "buy") {
      const usdcBalance = await getUSDCBalance();
      const quoteSize   = (usdcBalance * 0.05).toFixed(2);
      if (parseFloat(quoteSize) < 1) {
        console.log(`BUY SKIPPED [${productId}] — balance too low`);
        return res.status(200).json({ status: "skipped", reason: "balance too low" });
      }
      result = await placeOrder(productId, "BUY", { quote_size: quoteSize });
      console.log("BUY placed:", JSON.stringify(result));
      sendTelegram(`🟢 <b>BUY EXECUTED</b>\nSymbol: ${productId}\nPrice: $${price}\nSpent: $${quoteSize} (5% of $${usdcBalance.toFixed(2)} USDC)\nTime: ${time}`);
    }

    if (action === "sell") {
      const xrpBalance = await getXRPBalance();
      const baseSize   = xrpBalance.toFixed(6);
      if (parseFloat(baseSize) < 0.01) {
        console.log("SELL SKIPPED — no XRP to sell");
        return res.status(200).json({ status: "skipped", reason: "no XRP to sell" });
      }
      result = await placeOrder(productId, "SELL", { base_size: baseSize });
      console.log("SELL placed:", JSON.stringify(result));
      sendTelegram(`🔴 <b>SELL EXECUTED</b>\nSymbol: ${productId}\nPrice: $${price}\nXRP Sold: ${xrpBalance.toFixed(4)} XRP\nTime: ${time}`);
    }

    res.status(200).json({ status: "ok", result });

  } catch (err) {
    console.error("Webhook error:", err.message);
    sendTelegram(`❌ <b>BOT ERROR</b>\n${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

require("./signal.js");

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot live on port ${PORT}`);
  sendTelegram(`🤖 <b>Supertrend Bot Started</b>\nWatching: XRP-USDC | ADA-USDC | PEPE-USDC | XLM-USDC | BONK-USDC\nTimeframe: 15m | ATR: 7 | Factor: 1.0`);
});

