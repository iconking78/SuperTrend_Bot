# Supertrend Webhook Bot

TradingView Supertrend strategy → Coinbase Advanced Trade API

## Environment Variables (set in Render dashboard)

| Variable | Description | Example |
|---|---|---|
| `COINBASE_API_KEY` | Your Coinbase Advanced Trade API key | `organizations/xxx/apiKeys/yyy` |
| `COINBASE_API_SECRET` | Your Coinbase API secret (EC private key) | `-----BEGIN EC PRIVATE KEY-----...` |
| `QUOTE_SIZE` | USD amount to spend per BUY signal | `5%` |
| `BASE_SIZE` | XRP amount to sell per SELL signal | `100%` |
| `WEBHOOK_SECRET` | Optional password for your webhook URL | `Supertrend_Bot` |

## TradingView Alert Message (BUY)
```json
{"action":"buy","symbol":"{{ticker}}","price":{{close}},"time":"{{time}}"}
```

## TradingView Alert Message (SELL)
```json
{"action":"sell","symbol":"{{ticker}}","price":{{close}},"time":"{{time}}"}
```

## Webhook URL
```
https://your-render-url.onrender.com/github.com/iconking78/SuperTrend_Bot
```

Add header in TradingView: `x-webhook-secret: your_secret`
# SuperTrend_Bot
