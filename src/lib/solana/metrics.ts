import type { Candidate } from "@/lib/solana/parse";
import type { Coin, EntryPlan, HotTag, Signal } from "@/lib/solana/types";
import { CAP_MAX_USD, CAP_MIN_USD } from "@/lib/solana/types";
import { formatAge, formatPct, formatUsd } from "@/lib/solana/format";

export const RULES = {
  capMin: CAP_MIN_USD,
  capMax: CAP_MAX_USD,
  buyLiq: 20_000,
  buyVolH1: 8_000,
  buyBuys: 25,
  buyPressure: 0.55,
  buyH1Min: -8,
  buyH1Max: 45,
  buyAgeSec: 20 * 60,
  spike: 1.4,
  impulseH1: 8,
  youngAgeSec: 12 * 3600,
  youngVolToLiq: 0.25,
  avoidLiq: 5_000,
  avoidH1: -25,
  avoidPressure: 0.38,
  avoidSells: 10,
  avoidH24: -70,
  avoidYoungSec: 10 * 60,
  avoidYoungLiq: 12_000,
  deadVol: 300,
  deadAgeSec: 6 * 3600,
  chase: 0.08,
  stop: 0.15,
  liqStop: 0.5,
  clipPct: 0.01,
  hotSpike: 2.2,
  hotSpikeVol: 6_000,
  hotMomH1: 12,
  hotMomH6: 25,
  hotMomVol: 5_000,
  hotNewAge: 24 * 3600,
  hotNewVol: 2_500,
  hotPressure: 0.62,
  hotBuys: 40,
} as const;

const QUOTES = new Set(["SOL", "WSOL", "USDC", "USDT", "USD1", "UXD", "USDS"]);
const SOL_MINT = "So11111111111111111111111111111111111111112";

export type DropReason = "quote" | "unknown" | "high" | "low";

export function spikeOf(
  volH1: number | null,
  volH6: number | null,
  volH24: number | null,
  ageSec: number | null,
): number | null {
  if (volH1 == null || volH1 <= 0 || ageSec == null || ageSec < 3600) return null;
  const ageH = ageSec / 3600;
  if (ageH < 6 && volH6 != null && volH6 > 0) {
    const pace = volH6 / Math.min(ageH, 6);
    return pace > 0 ? volH1 / pace : null;
  }
  if (volH24 != null && volH24 > 0) {
    const pace = volH24 / Math.min(ageH, 24);
    return pace > 0 ? volH1 / pace : null;
  }
  return null;
}

function hotTags(input: {
  volH1: number | null;
  h1: number | null;
  h6: number | null;
  ageSec: number | null;
  spike: number | null;
  pressure: number | null;
  buys: number;
}): HotTag[] {
  const hot: HotTag[] = [];
  const vol = input.volH1 ?? 0;
  if (input.spike != null && input.spike >= RULES.hotSpike && vol >= RULES.hotSpikeVol) {
    hot.push("vol spike");
  }
  if (input.h1 != null && input.h1 >= RULES.hotMomH1 && vol >= RULES.hotMomVol) {
    hot.push("momentum");
  } else if (
    input.h6 != null &&
    input.h6 >= RULES.hotMomH6 &&
    (input.h1 == null || input.h1 > RULES.buyH1Min) &&
    vol >= RULES.hotMomVol
  ) {
    hot.push("momentum");
  }
  if (
    input.ageSec != null &&
    input.ageSec < RULES.hotNewAge &&
    vol >= RULES.hotNewVol
  ) {
    hot.push("new");
  }
  if (
    input.pressure != null &&
    input.pressure >= RULES.hotPressure &&
    input.buys >= RULES.hotBuys
  ) {
    hot.push("buy pressure");
  }
  return hot;
}

function buildWhy(parts: {
  volH1: number | null;
  spike: number | null;
  liq: number;
  h1: number | null;
  h24: number | null;
  ageSec: number | null;
  tx: { buys: number; sells: number } | null;
  pressure: number | null;
  signal: Signal;
  fail: string | null;
}): string {
  const bits: string[] = [];
  if (parts.volH1 != null) {
    if (parts.spike != null) {
      bits.push(`1h vol ${formatUsd(parts.volH1)} (${parts.spike.toFixed(1)}× pace)`);
    } else if (parts.ageSec != null && parts.ageSec < 3600) {
      bits.push(`1h vol ${formatUsd(parts.volH1)} (under 1h, no pace)`);
    } else {
      bits.push(`1h vol ${formatUsd(parts.volH1)}`);
    }
  } else {
    bits.push("1h vol n/a");
  }
  bits.push(`liq ${formatUsd(parts.liq)}`);
  if (parts.h1 != null) bits.push(`1h ${formatPct(parts.h1)}`);
  if (parts.h24 != null) bits.push(`24h ${formatPct(parts.h24)}`);
  bits.push(parts.ageSec == null ? "age n/a" : `age ${formatAge(parts.ageSec)}`);
  if (parts.tx && parts.pressure != null) {
    const pct = Math.round(parts.pressure * 100);
    bits.push(`buys/sells ${parts.tx.buys}/${parts.tx.sells} (${pct}% buys)`);
  } else {
    bits.push("buys/sells n/a");
  }
  const lead = `${bits.join(" · ")}.`;
  if (parts.signal === "AVOID") return `${lead} Fail: ${parts.fail ?? "rule"}.`;
  if (parts.signal === "BUY") return `${lead} Passes liq, flow, and extension checks.`;
  return `${lead} Missing: ${parts.fail ?? "confirmation"}.`;
}

function entryFor(price: number, liq: number): EntryPlan {
  const clipUsd = Math.max(1, Math.round(liq * RULES.clipPct));
  return {
    price,
    chaseAbove: price * (1 + RULES.chase),
    invalidPrice: price * (1 - RULES.stop),
    invalidLiq: liq * RULES.liqStop,
    clipUsd,
  };
}

export function evaluate(
  c: Candidate,
): { coin: Omit<Coin, "label"> & { score: number } } | { drop: DropReason } {
  const symbol = c.symbol.trim();
  if (!symbol || QUOTES.has(symbol.toUpperCase()) || c.mint === SOL_MINT) {
    return { drop: "quote" };
  }
  if (!(c.price > 0)) return { drop: "unknown" };

  const mc = c.mc != null && c.mc > 0 ? c.mc : null;
  const fdv = c.fdv != null && c.fdv > 0 ? c.fdv : null;
  if (mc == null && fdv == null) return { drop: "unknown" };
  const figures = [mc, fdv].filter((n): n is number => n != null);
  if (figures.some((n) => n >= RULES.capMax)) return { drop: "high" };
  if (figures.some((n) => n < RULES.capMin)) return { drop: "low" };
  const capKind = mc != null ? "mc" : "fdv";
  const cap = (capKind === "mc" ? mc : fdv) as number;

  const liq = c.liq > 0 ? c.liq : 0;
  const volH1 = c.vol.h1;
  const h1 = c.change.h1;
  const h6 = c.change.h6;
  const h24 = c.change.h24;
  const ageSec = c.ageSec;
  const tx = c.txH1;
  const buys = tx?.buys ?? 0;
  const sells = tx?.sells ?? 0;
  const pressure = tx && buys + sells > 0 ? buys / (buys + sells) : null;
  const spike = spikeOf(volH1, c.vol.h6, c.vol.h24, ageSec);

  const avoid: string[] = [];
  if (liq < RULES.avoidLiq) avoid.push(`liq under ${formatUsd(RULES.avoidLiq)}`);
  if (h1 != null && h1 <= RULES.avoidH1) avoid.push(`1h price ${formatPct(h1)}`);
  if (pressure != null && pressure < RULES.avoidPressure && sells >= RULES.avoidSells) {
    avoid.push("sells lead 1h flow");
  }
  if (h24 != null && h24 <= RULES.avoidH24 && (h1 == null || h1 < 5)) {
    avoid.push("24h drawdown, no bounce");
  }
  if (ageSec != null && ageSec < RULES.avoidYoungSec && liq < RULES.avoidYoungLiq) {
    avoid.push("under 10m old with thin liq");
  }
  if (ageSec != null && ageSec > RULES.deadAgeSec && (volH1 ?? 0) < RULES.deadVol) {
    avoid.push("no 1h volume");
  }

  let signal: Signal;
  let fail: string | null = null;
  if (avoid.length) {
    signal = "AVOID";
    fail = avoid[0] ?? null;
  } else {
    const buyFails: string[] = [];
    if (liq < RULES.buyLiq) buyFails.push(`liq under ${formatUsd(RULES.buyLiq)}`);
    if ((volH1 ?? 0) < RULES.buyVolH1) buyFails.push(`1h vol under ${formatUsd(RULES.buyVolH1)}`);
    if (!tx) buyFails.push("no 1h buy/sell counts");
    else if (pressure == null || pressure < RULES.buyPressure) {
      const shown = pressure == null ? "n/a" : `${Math.round(pressure * 100)}%`;
      buyFails.push(`buy share ${shown} under 55%`);
    }
    if (buys < RULES.buyBuys) buyFails.push(`under ${RULES.buyBuys} buys in 1h`);
    if (h1 == null) buyFails.push("no 1h price");
    else if (h1 < RULES.buyH1Min) buyFails.push(`1h ${formatPct(h1)} under −8%`);
    else if (h1 > RULES.buyH1Max) buyFails.push(`1h ${formatPct(h1)} already extended`);
    if (ageSec == null) buyFails.push("age unknown");
    else if (ageSec < RULES.buyAgeSec) buyFails.push("pool under 20m");
    const youngImpulse =
      ageSec != null &&
      ageSec < RULES.youngAgeSec &&
      liq > 0 &&
      (volH1 ?? 0) / liq >= RULES.youngVolToLiq &&
      (h1 ?? 0) > 0;
    const impulse =
      (spike != null && spike >= RULES.spike) ||
      (h1 != null && h1 >= RULES.impulseH1) ||
      youngImpulse;
    if (!impulse) buyFails.push("no vol spike or impulse");
    if (buyFails.length === 0) signal = "BUY";
    else {
      signal = "WATCH";
      fail = buyFails[0] ?? null;
    }
  }

  const hot = hotTags({ volH1, h1, h6, ageSec, spike, pressure, buys });
  const why = buildWhy({
    volH1,
    spike,
    liq,
    h1,
    h24,
    ageSec,
    tx,
    pressure,
    signal,
    fail,
  });

  let score = 0;
  score += Math.log10((volH1 ?? 0) + 10) * 14;
  score += Math.log10(liq + 10) * 6;
  if (pressure != null) score += pressure * 16;
  if (spike != null) score += Math.min(spike, 5) * 3;
  if (h1 != null) score += Math.max(-25, Math.min(35, h1)) * 0.2;
  if (ageSec != null && ageSec < RULES.hotNewAge) score += 4;
  score += hot.length * 3;
  if (signal === "BUY") score += 10;
  if (signal === "AVOID") score -= 8;

  const coin: Omit<Coin, "label"> & { score: number } = {
    mint: c.mint,
    pool: c.pool,
    symbol,
    name: c.name || symbol,
    dex: c.dex || "unknown",
    price: c.price,
    mc,
    fdv,
    cap,
    capKind,
    liq,
    ageSec,
    change: c.change,
    vol: c.vol,
    txH1: tx,
    pressure,
    spike,
    hot,
    signal,
    why,
    entry: signal === "BUY" ? entryFor(c.price, liq) : null,
    lists: c.lists,
    score,
  };

  return { coin };
}

export function rankCoins(candidates: Candidate[]): {
  coins: Coin[];
  unique: number;
  droppedHighCap: number;
  droppedLowCap: number;
  droppedUnknownCap: number;
  passed: number;
} {
  const byMint = new Map<string, Candidate>();
  for (const c of candidates) {
    const prev = byMint.get(c.mint);
    if (!prev) {
      byMint.set(c.mint, c);
      continue;
    }
    const primary = c.liq > prev.liq ? c : prev;
    const secondary = primary === c ? prev : c;
    byMint.set(c.mint, {
      ...primary,
      lists: [...new Set([...primary.lists, ...secondary.lists])],
      txH1: primary.txH1 ?? secondary.txH1,
      txH24: primary.txH24 ?? secondary.txH24,
      mc: primary.mc ?? secondary.mc,
      fdv: primary.fdv ?? secondary.fdv,
      ageSec: primary.ageSec ?? secondary.ageSec,
      vol: {
        m5: primary.vol.m5 ?? secondary.vol.m5,
        h1: primary.vol.h1 ?? secondary.vol.h1,
        h6: primary.vol.h6 ?? secondary.vol.h6,
        h24: primary.vol.h24 ?? secondary.vol.h24,
      },
      change: {
        m5: primary.change.m5 ?? secondary.change.m5,
        h1: primary.change.h1 ?? secondary.change.h1,
        h6: primary.change.h6 ?? secondary.change.h6,
        h24: primary.change.h24 ?? secondary.change.h24,
      },
    });
  }

  let droppedHighCap = 0;
  let droppedLowCap = 0;
  let droppedUnknownCap = 0;
  const scored: (Omit<Coin, "label"> & { score: number })[] = [];
  for (const c of byMint.values()) {
    const result = evaluate(c);
    if ("drop" in result) {
      if (result.drop === "high") droppedHighCap += 1;
      else if (result.drop === "low") droppedLowCap += 1;
      else if (result.drop === "unknown") droppedUnknownCap += 1;
      continue;
    }
    scored.push(result.coin);
  }
  scored.sort(
    (a, b) => b.score - a.score || (b.vol.h1 ?? 0) - (a.vol.h1 ?? 0),
  );

  const symbolCount = new Map<string, number>();
  for (const c of scored) symbolCount.set(c.symbol, (symbolCount.get(c.symbol) ?? 0) + 1);

  const coins: Coin[] = scored.slice(0, 30).map((c) => {
    const { score: _score, ...rest } = c;
    const crowded = (symbolCount.get(c.symbol) ?? 0) > 1;
    return {
      ...rest,
      label: crowded ? `${c.symbol}·${c.mint.slice(-4)}` : c.symbol,
    };
  });

  return {
    coins,
    unique: droppedHighCap + droppedLowCap + droppedUnknownCap + scored.length,
    droppedHighCap,
    droppedLowCap,
    droppedUnknownCap,
    passed: scored.length,
  };
}
