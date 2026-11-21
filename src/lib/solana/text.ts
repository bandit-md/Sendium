import { formatAge, formatCap, formatPct, formatPx, formatUsd, formatUtc } from "@/lib/solana/format";
import { RULES } from "@/lib/solana/metrics";
import type { Coin, JournalEntry, ScanOk } from "@/lib/solana/types";

export function rulesText(): string {
  return [
    "Sendium rules · Solana only",
    `Keep a pool only if market cap and FDV are both between ${formatUsd(RULES.capMin)} and ${formatUsd(RULES.capMax)}, or the one printed cap is in that band and the other is missing. No cap on the feed → dropped. Either figure outside the band → dropped.`,
    "",
    "BUY only if all of these pass:",
    `· liq ≥ ${formatUsd(RULES.buyLiq)}`,
    `· 1h vol ≥ ${formatUsd(RULES.buyVolH1)}`,
    `· 1h buys ≥ ${RULES.buyBuys} and buy share ≥ ${Math.round(RULES.buyPressure * 100)}%`,
    `· 1h price between ${formatPct(RULES.buyH1Min)} and ${formatPct(RULES.buyH1Max)}`,
    `· pool age ≥ ${formatAge(RULES.buyAgeSec)}`,
    `· vol spike ≥ ${RULES.spike}× pace, or 1h ≥ ${formatPct(RULES.impulseH1)}, or age < 12h with 1h vol ≥ ${Math.round(RULES.youngVolToLiq * 100)}% of liq and price up`,
    "",
    "WATCH: inside the cap band, not an avoid, at least one buy check failed.",
    `AVOID: liq < ${formatUsd(RULES.avoidLiq)}, 1h ≤ ${formatPct(RULES.avoidH1)}, sells lead 1h flow, 24h ≤ ${formatPct(RULES.avoidH24)} with no bounce, under 10m with liq < ${formatUsd(RULES.avoidYoungLiq)}, or 1h vol < ${formatUsd(RULES.deadVol)} after 6h.`,
    "",
    `Entry is printed only on BUY. Spot = last price. Chase cap +${Math.round(RULES.chase * 100)}%. Rule stop −${Math.round(RULES.stop * 100)}% or liq −${Math.round(RULES.liqStop * 100)}%. 1% of pool liq is size context, not a recommendation.`,
    "ROI uses the hour-candle close covering +1h / +4h / +24h when that candle has closed. Otherwise pending or n/a. Now = latest price vs entry.",
    "Hot tags: vol spike, momentum, new, buy pressure. Only when those prints clear the thresholds.",
    "Not advice.",
  ].join("\n");
}

export function helpText(): string {
  return [
    "Sendium · commands",
    `/scan · around $250k (${formatUsd(RULES.capMin)}–${formatUsd(RULES.capMax)})`,
    "/buys · BUY only",
    "/watch · WATCH only",
    "/avoid · AVOID only",
    "/hot · vol spike, momentum, new, buy pressure",
    "/new · pools under 24h",
    "/roi · 1h / 4h / 24h vs entry",
    "/token SYMBOL · one coin",
    "/rules · the exact checks",
    `I only rank caps from ${formatUsd(RULES.capMin)} to ${formatUsd(RULES.capMax)}. I do not fill gaps with guesses.`,
  ].join("\n");
}

function coinBlock(c: Coin, rank: number): string {
  const tags = c.hot.length ? `  · ${c.hot.join(", ")}` : "";
  const ch = [
    c.change.h1 != null ? `1h ${formatPct(c.change.h1)}` : null,
    c.change.h6 != null ? `6h ${formatPct(c.change.h6)}` : null,
    c.change.h24 != null ? `24h ${formatPct(c.change.h24)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const vol = [
    c.vol.h1 != null ? `vol 1h ${formatUsd(c.vol.h1)}` : null,
    c.vol.h24 != null ? `24h ${formatUsd(c.vol.h24)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const flow = c.txH1
    ? `buys/sells 1h ${c.txH1.buys}/${c.txH1.sells} (${Math.round((c.pressure ?? 0) * 100)}% buys)`
    : "buys/sells 1h n/a";
  const lines = [
    `${rank}) ${c.label}  ${c.signal}${tags}`,
    `${formatPx(c.price)} · ${formatCap(c)} · liq ${formatUsd(c.liq)}`,
    ch || "price change n/a",
    vol || "volume n/a",
    flow,
    `age ${c.ageSec == null ? "n/a" : formatAge(c.ageSec)} · ${c.dex}`,
    `Why: ${c.why}`,
  ];
  if (c.entry) {
    lines.push(
      `Entry ${formatPx(c.entry.price)} · no chase above ${formatPx(c.entry.chaseAbove)} · stop ${formatPx(c.entry.invalidPrice)} or liq < ${formatUsd(c.entry.invalidLiq)} · 1% liq ≈ ${formatUsd(c.entry.clipUsd)}`,
    );
  } else {
    lines.push("No entry.");
  }
  return lines.join("\n");
}

export function coinDetail(c: Coin): string {
  return [
    coinBlock(c, 1).replace(/^1\) /, ""),
    `mint ${c.mint}`,
    `https://dexscreener.com/solana/${c.mint}`,
  ].join("\n");
}

type NowPrice = { mint: string; price: number };

function ret(entry: number, price: number): number {
  return ((price - entry) / entry) * 100;
}

export function roiFooter(
  entries: JournalEntry[],
  nowPrices: NowPrice[],
  now: number,
): string {
  if (entries.length === 0) return "ROI · none logged yet";
  const priceOf = new Map(nowPrices.map((p) => [p.mint, p.price]));
  const buys = entries.filter((e) => e.signal === "BUY");
  const lineFor = (label: string, rows: JournalEntry[], key: "h1" | "h4" | "h24" | "now") => {
    const vals: number[] = [];
    for (const e of rows) {
      if (key === "now") {
      if (now - e.at < 5 * 60 * 1000) continue;
      const px = priceOf.get(e.mint);
      if (px != null && px > 0) vals.push(ret(e.entryPrice, px));
    } else {
        const mark = e[key];
        if (mark && typeof mark === "object") vals.push(mark.ret);
      }
    }
    if (!vals.length) return null;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const up = vals.filter((v) => v > 0).length;
    return `${label} ${formatPct(avg)} (n=${vals.length}, ${up} up)`;
  };
  const buyNow = lineFor("BUY now", buys, "now");
  const buy1 = lineFor("BUY 1h", buys, "h1");
  const buy4 = lineFor("BUY 4h", buys, "h4");
  const buy24 = lineFor("BUY 24h", buys, "h24");
  const bits = [buyNow, buy1, buy4, buy24].filter(Boolean);
  const matured = entries.some((e) => now - e.at >= 3_600_000);
  if (!bits.length) {
    return `ROI · ${entries.length} logged · 1h/4h/24h ${matured ? "not in yet" : "pending"}`;
  }
  return `ROI · ${bits.join(" · ")}`;
}

export function formatScan(
  scan: ScanOk,
  coins: Coin[],
  journal: JournalEntry[],
  prices: { mint: string; price: number }[],
): string {
  const head = [
    `Sendium · SOL · cap/FDV ${formatUsd(RULES.capMin)}–${formatUsd(RULES.capMax)}`,
    `${formatUtc(scan.scannedAt)} · ${scan.source}`,
    `unique ${scan.unique} · kept ${scan.kept} · above band ${scan.droppedHighCap} · below band ${scan.droppedLowCap} · no cap ${scan.droppedUnknownCap}`,
    coins.length
      ? `${coins.filter((c) => c.signal === "BUY").length} BUY in this cut`
      : "none in the band in this cut",
  ];
  const body = coins.length
    ? coins.map((c, i) => coinBlock(c, i + 1)).join("\n\n")
    : "No Solana pool in this pull cleared the cap filter. Nothing listed.";
  return [...head, "", body, "", roiFooter(journal, prices, scan.scannedAt)].join("\n");
}

export function formatList(
  title: string,
  scan: ScanOk,
  coins: Coin[],
  journal: JournalEntry[],
  prices: { mint: string; price: number }[],
): string {
  const body = coins.length
    ? coins.map((c, i) => coinBlock(c, i + 1)).join("\n\n")
    : `None in the ${formatUsd(RULES.capMin)}–${formatUsd(RULES.capMax)} band match this cut.`;
  return [
    `Sendium · ${title}`,
    `${formatUtc(scan.scannedAt)} · kept ${scan.kept} of ${scan.unique}`,
    "",
    body,
    "",
    roiFooter(journal, prices, scan.scannedAt),
  ].join("\n");
}

function horizonCell(
  entry: JournalEntry,
  key: "h1" | "h4" | "h24",
  hours: number,
  now: number,
): string {
  const mark = entry[key];
  if (mark && typeof mark === "object") return `${key} ${formatPct(mark.ret)}`;
  if (now - entry.at < hours * 3_600_000) return `${key} pending`;
  if (mark === null) return `${key} n/a`;
  return `${key} …`;
}

export function formatRoi(
  entries: JournalEntry[],
  nowPrices: NowPrice[],
  now: number,
): string {
  const priceOf = new Map(nowPrices.map((p) => [p.mint, p.price]));
  if (!entries.length) {
    return "Sendium · ROI\nNo signals stored yet. BUY and hot WATCH prints are logged on each scan.\n\nROI · none logged yet";
  }
  const lines = entries.slice(0, 12).map((e, i) => {
    const px = priceOf.get(e.mint);
    const nowBit =
      px != null && px > 0
        ? `entry ${formatPx(e.entryPrice)} → now ${formatPx(px)} (${formatPct(ret(e.entryPrice, px))})`
        : `entry ${formatPx(e.entryPrice)} → now n/a`;
    return [
      `${i + 1}) ${e.symbol} ${e.signal} · ${e.capLabel} · liq ${formatUsd(e.liq)}`,
      nowBit,
      [horizonCell(e, "h1", 1, now), horizonCell(e, "h4", 4, now), horizonCell(e, "h24", 24, now)].join(
        " · ",
      ),
    ].join("\n");
  });
  return [
    "Sendium · ROI",
    "Hour-candle close at +1h / +4h / +24h. Pending until that candle closes. n/a = no candle.",
    "",
    lines.join("\n\n"),
    "",
    roiFooter(entries, nowPrices, now),
  ].join("\n");
}

export function feedDown(error: string): string {
  return `Sendium · feed down\n${error}\nNo coins listed. Nothing invented.`;
}
