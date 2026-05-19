("/", (req, res) => res.send("Supertrend bot is live ✅"));

app.post("/webhook", async (req, res) => {
  try {
    const { action, symbol, secret, price, time } = req.body;
    if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!action || !symbol) {
      return res.status(400).json({ error: "Missing action or symbol" });
    }
    const productId = symbol.replace(/([A-Z]+)(USDT?|BTC|ETH)$/, "$1-$2");
    console.log(`Signal: ${action.toUpperCase()} ${productId} @ ${price} [${time}]`);
    let result;
    if (action === "buy") {
      const usdBalance = await getUSDBalance();
      const quoteSize  = (usdBalance * 0.05).toFixed(2);
      if (parseFloat(quoteSize) < 1) return res.status(200).json({ status: "skipped", reason: "balance too low" });
      console.log(`USD: $${usdBalance} -> Spending: $${quoteSize}`);
      result = await placeOrder(productId, "BUY", { quote_size: quoteSize });
      console.log("BUY placed:", JSON.stringify(result));
    }
    if (action === "sell") {
      const xrpBalance = await getXRPBalance();
      const baseSize   = xrpBalance.toFixed(6);
      if (parseFloat(baseSize) < 0.01) return res.status(200).json({ status: "skipped", reason: "no XRP to sell" });
      console.log(`XRP: ${xrpBalance} -> Selling all`);
      result = await placeOrder(productId, "SELL", { base_size: baseSize });
      console.log("SELL placed:", JSON.stringify(result));
    }
    res.status(200).json({ status: "ok", result });
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Start signal checker inline
require("./signal.js");

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot live on port ${PORT}`));
  
