          const express = require("express");
const crypto  = require("crypto");
const https   = require("https");
const jwt     = require("jsonwebtoken");

const app = express();
app.use(express.json());

const API_KEY        = (process.env.COINBASE_API_KEY || "").trim();
const API_SECRET_RAW = (process.env.COINBASE_API_SECRET || "").trim();
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const TG_TOKEN       = process.env.TELEGRAM_TOKEN || "";
const TG_CHAT_ID     = process.env.TELEGRAM_CHAT_ID || "";

// Normalize secret key newlines
const API_SECRET = API_SECRET_RAW.replace(/\\n/g, "\n");

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

// JWT authentication for Coinbase Advanced Trade
function makeJWT(method, path) {
  const uri = `${method} api.coinbase.com${path}`;
  return jwt.sign(
    {
      sub: API_KEY,
      iss: "cdp",
      nbf: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 120,
      uri,
    },
    API_SECRET,
    {
      algorithm: "ES256",
      header: { kid: API_KEY, nonce: crypto.randomBytes(16).toString("hex") },
    }
  );
}

function cbRequest(method, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : "";
    let token;
    try {
      token = makeJWT(method, path);
    } catch(e) {
      return reject(new Error(`JWT sign failed: ${e.message}`));
    }
    const req = https.request({
      hostname: "api.coinbase.com", path, method,
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${token}`,
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`Coinbase response: ${data}`)); }
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}


async function getAllAccounts() {
  let accounts = [];
  let cursor = null;
  do {
    const path = "/api/v3/brokerage/accounts?limit=250&retail_portfolio_id=DEFAULT" + (cursor ? "&cursor=" + cursor : "");
    const data = await cbRequest("GET", path, null);
    accounts = accounts.concat(data.accounts || []);
    cursor = data.has_next ? data.cursor : null;
  } while (cursor);
  return accounts;
}

async function getUSDBalance() {
  const accounts = await getAllAccounts();
  const acc = accounts.find(a => a.currency === "USD");
  return parseFloat(acc?.available_balance?.value || "0");
}

async function getXRPBalance() {
  const accounts = await getAllAccounts();
  const acc = accounts.find(a => a.currency === "XRP");
  return parseFloat(acc?.available_balance?.value || "0");
}

async function placeOrder(productId, side, sizeConfig) {
  return cbRequest("POST", "/api/v3/brokerage/orders", {
    client_order_id: `supertrend-${Date.now()}`,
    product_id: productId,
    side: side.toUpperCase(),
    order_configuration: { market_market_ioc: sizeConfig },
  });
}

app.get("/", (req, res) => res.send("Supertrend bot is live ✅"));

app.get("/test", async (req, res) => {
  try {
    const usd = await getUSDBalance();
    const xrp = await getXRPBalance();
    res.json({ status: "ok", usd_balance: usd, xrp_balance: xrp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/accounts", async (req, res) => {
  try {
    const all = await getAllAccounts();
    const accounts = all.map(a => ({
      currency: a.currency,
      available: a.available_balance?.value,
      hold: a.hold?.value,
      name: a.name,
      type: a.type,
      uuid: a.uuid,
    }));
    // Also try payment methods for fiat
    let fiat = null;
    try {
      fiat = await cbRequest("GET", "/api/v3/brokerage/payment_methods", null);
    } catch(e) {}
    res.json({ total: accounts.length, accounts, fiat_methods: fiat?.payment_methods?.map(p => ({ name: p.name, type: p.type, currency: p.currency, available: p.allow_buy })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const { action, symbol, secret, price, time } = req.body;
    if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
    if (!action || !symbol) return res.status(400).json({ error: "Missing action or symbol" });
    const productId = symbol.replace(/([A-Z]+)(USDT?|BTC|ETH)$/, "$1-$2");
    console.log(`Signal: ${action.toUpperCase()} ${productId} @ ${price}`);
    let result;
    if (action === "buy") {
      const usdBalance = await getUSDBalance();
      const quoteSize  = (usdBalance * 0.05).toFixed(2);
      if (parseFloat(quoteSize) < 1) {
        sendTelegram(`⚠️ <b>BUY SKIPPED</b>\nSymbol: ${productId}\nReason: USD balance too low ($${usdBalance})`);
        return res.status(200).json({ status: "skipped", reason: "balance too low" });
      }
      result = await placeOrder(productId, "BUY", { quote_size: quoteSize });
      console.log("BUY placed:", JSON.stringify(result));
      sendTelegram(`🟢 <b>BUY EXECUTED</b>\nSymbol: ${productId}\nPrice: $${price}\nSpent: $${quoteSize} (5% of $${usdBalance.toFixed(2)})\nTime: ${time}`);
    }
    if (action === "sell") {
      const xrpBalance = await getXRPBalance();
      const baseSize   = xrpBalance.toFixed(6);
      if (parseFloat(baseSize) < 0.01) {
        sendTelegram(`⚠️ <b>SELL SKIPPED</b>\nSymbol: ${productId}\nReason: No XRP to sell`);
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
  sendTelegram(`🤖 <b>Supertrend Bot Started</b>\nWatching XRP-USD on 15m chart\nATR: 7 | Factor: 1.0`);
});
