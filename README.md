# Sendium

Solana desk for pools whose market cap and FDV are both between $150k and $400k.

Signals are rule-based from the live pool feed (GeckoTerminal, with DexScreener as backup). Nothing is filled in when a figure is missing.

- BUY / WATCH / AVOID, with entry context only on BUY
- Why line uses volume, liquidity, price change, age, and buy/sell pressure
- ROI at 1h / 4h / 24h from closed hour candles
- Optional Telegram send from a BotFather token kept in the browser

```bash
npm install
npm run dev
```

Not advice.
