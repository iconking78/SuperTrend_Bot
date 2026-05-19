const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const API_KEY    = process.env."name": "organizations/81638aa8-cec3-4302-ab61-81f6571245bf/apiKeys/0ca7c925-d95d-4a45-9aa9-103d8dbaf921",;
const API_SECRET = process.env.-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIFh9C1/QaF6SN/R28b/U3jZ4OQpG8sz1yQkNkEqJJK4GoAoGCCqGSM49\nAwEHoUQDQgAEvnfo3LhrlB8tCYrxL7nH4XxsI28aetKoqAX1reLZMs4BN4xyaZP/\neCmr9JG+x25pKoRqgti5sxs/naNxavPKkg==\n-----END EC PRIVATE KEY-----\n"
};
const WEBHOOK_SECRET = process.env.Supertrend_Bot || "";

function signRequest(method, path, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message   = timestamp + method.toUpperCase() + path + (body || "");
  const signature = crypto
    .createHmac("sha256", API_SECRET)
    .update(message)
    .digest("hex");
  return { timestamp, signature };
}

async function placeOrder(productId, side, quoteSize = "10") {
  const path   = "/api/v3/brokerage/orders";
  const url    = "https://api.coinbase.com" + path;
  const clientOrderId = `supertrend-${Date.now()}`;

  const bodyObj = {
    client_order_id: clientOrderId,
    product_id: productId,
    side: side.toUpperCase(),
    order_configuration: {
      market_market_ioc: {
        ...(side.toUpperCase() === "BUY"
          ? { quote_size: quoteSize }
          : { base_size: process.env.BASE_SIZE || "10" }),
      },
    },
  };

  const bodyStr        = JSON.stringify(bodyObj);
  const { timestamp, signature } = signRequest("POST", path, bodyStr);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "CB-ACCESS-KEY":        API_KEY,
      "CB-ACCESS-SIGN":       signature,
      "CB-ACCESS-TIMESTAMP":  timestamp,
    },
    body: bodyStr,
  });

  const data = await res.json();
  return data;
}

// Health check
app.get("/", (req, res) => res.send("Supertrend bot is live ✅"));

// Webhook endpoint
app.post("/webhook", async (req, res) => {
  try {
    // Optional secret check
    if (WEBHOOK_SECRET) {
      const incoming = req.headers["x-webhook-secret"];
      if (incoming !== WEBHOOK_SECRET) {
        console.warn("Unauthorized webhook attempt");
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const { action, symbol } = req.body;

    if (!action || !symbol) {
      return res.status(400).json({ error: "Missing action or symbol" });
    }

    // Convert TV ticker to Coinbase product id e.g. XRPUSD → XRP-USD
    const productId = symbol.replace(/([A-Z]+)(USD|USDT|BTC|ETH)$/, "$1-$2");

    console.log(`Signal received: ${action.toUpperCase()} ${productId} @ ${new Date().toISOString()}`);

    let result;

    if (action === "buy") {
      const quoteSize = process.env.QUOTE_SIZE || "10"; // USD amount to spend
      result = await placeOrder(productId, "BUY", quoteSize);
      console.log("BUY order placed:", JSON.stringify(result, null, 2));
    }

    if (action === "sell") {
      result = await placeOrder(productId, "SELL");
      console.log("SELL order placed:", JSON.stringify(result, null, 2));
    }

    res.status(200).json({ status: "ok", result });

  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot listening on port ${PORT}`));
