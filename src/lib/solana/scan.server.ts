import { rankCoins } from "@/lib/solana/metrics";
import {
  asArray,
  asRecord,
  isSolanaAddress,
  num,
  parseDexPayload,
  parseGtPayload,
  type Candidate,
} from "@/lib/solana/parse";
import type { HorizonState, QuoteResult, QuoteRow, ScanResult } from "@/lib/solana/types";

const GT = "https://api.geckoterminal.com/api/v2";
const TTL_MS = 40_000;
const HEADERS = {
  Accept: "application/json",
  "User-Agent": "Sendium/1.0",
};

type OkScan = Extract<ScanResult, { ok: true }>;

let cache: { at: number; data: OkScan } | null = null;
let inflight: Promise<ScanResult> | null = null;

const ohlcvCache = new Map<string, { at: number; candles: Candle[] | null }>();
let priceCache: { at: number; map: Map<string, number> } | null = null;

type Candle = { t: number; c: number };

async function fetchJson(url: string): Promise<unknown | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
      if (res.ok) return await res.json();
      const retry = res.status === 429 || res.status === 502 || res.status === 503;
      if (!retry || attempt === 1) return null;
      const header = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(header) && header > 0 && header <= 3 ? header * 1000 : 700;
      await new Promise((resolve) => setTimeout(resolve, wait));
    } catch {
      return null;
    }
  }
  return null;
}

async function loadGt(): Promise<{ pools: Candidate[]; source: string }> {
  const pages: { url: string; list: string }[] = [
    { url: `${GT}/networks/solana/trending_pools?include=base_token&page=1`, list: "trending" },
    { url: `${GT}/networks/solana/new_pools?include=base_token&page=1`, list: "new" },
  ];
  const first = await Promise.all(pages.map((p) => fetchJson(p.url)));
  let pools = pages.flatMap((p, i) => parseGtPayload(first[i], p.list));
  const got = first.some(Boolean);
  if (got) {
    const moreSpec = [
      { url: `${GT}/networks/solana/trending_pools?include=base_token&page=2`, list: "trending" },
      { url: `${GT}/networks/solana/new_pools?include=base_token&page=2`, list: "new" },
    ];
    const more = await Promise.all(moreSpec.map((p) => fetchJson(p.url)));
    pools = pools.concat(moreSpec.flatMap((p, i) => parseGtPayload(more[i], p.list)));
  }
  return { pools, source: got ? "GeckoTerminal trending+new" : "" };
}

function solanaMintsFromBoosts(payloads: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const payload of payloads) {
    for (const item of asArray(payload)) {
      const rec = asRecord(item);
      if (!rec || rec.chainId !== "solana" || typeof rec.tokenAddress !== "string") continue;
      if (!isSolanaAddress(rec.tokenAddress) || seen.has(rec.tokenAddress)) continue;
      seen.add(rec.tokenAddress);
      out.push(rec.tokenAddress);
      if (out.length >= 30) return out;
    }
  }
  return out;
}

async function loadDex(): Promise<Candidate[]> {
  const [top, latest] = await Promise.all([
    fetchJson("https://api.dexscreener.com/token-boosts/top/v1"),
    fetchJson("https://api.dexscreener.com/token-profiles/latest/v1"),
  ]);
  const mints = solanaMintsFromBoosts([top, latest]);
  if (!mints.length) return [];
  const pairs = await fetchJson(
    `https://api.dexscreener.com/tokens/v1/solana/${mints.join(",")}`,
  );
  return parseDexPayload(pairs, "discovery");
}

async function doScan(): Promise<ScanResult> {
  const gt = await loadGt();
  let pools = gt.pools;
  let source = gt.source;
  if (rankCoins(pools).coins.length < 8) {
    const dex = await loadDex();
    if (dex.length) {
      pools = pools.concat(dex);
      source = source ? `${source} + DexScreener` : "DexScreener";
    }
  }
  if (!pools.length) {
    return {
      ok: false,
      scannedAt: Date.now(),
      error: "GeckoTerminal and DexScreener returned no Solana pools.",
    };
  }
  const ranked = rankCoins(pools);
  const data: OkScan = {
    ok: true,
    scannedAt: Date.now(),
    source: source || "pool feed",
    unique: ranked.unique,
    droppedHighCap: ranked.droppedHighCap,
    droppedLowCap: ranked.droppedLowCap,
    droppedUnknownCap: ranked.droppedUnknownCap,
    kept: ranked.passed,
    coins: ranked.coins,
  };
  cache = { at: Date.now(), data };
  return data;
}

export function runScan(fresh: boolean): Promise<ScanResult> {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.data);
  if (inflight) return fresh ? inflight.then(() => runScan(true)) : inflight;
  inflight = doScan().finally(() => {
    inflight = null;
  });
  return inflight;
}

function parseCandles(json: unknown): Candle[] {
  const attrs = asRecord(asRecord(asRecord(json)?.data)?.attributes);
  const candles: Candle[] = [];
  for (const row of asArray(attrs?.ohlcv_list)) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const tRaw = num(row[0]);
    const close = num(row[4]);
    if (tRaw == null || close == null || close <= 0) continue;
    const t = tRaw > 10_000_000_000 ? Math.floor(tRaw / 1000) : tRaw;
    candles.push({ t, c: close });
  }
  candles.sort((a, b) => a.t - b.t);
  return candles;
}

async function candlesFor(pool: string): Promise<Candle[] | null> {
  const hit = ohlcvCache.get(pool);
  if (hit && Date.now() - hit.at < 180_000) return hit.candles;
  const json = await fetchJson(
    `${GT}/networks/solana/pools/${pool}/ohlcv/hour?aggregate=1&limit=100&currency=usd&token=base`,
  );
  const candles = json ? parseCandles(json) : null;
  ohlcvCache.set(pool, { at: Date.now(), candles });
  return candles;
}

function horizonFromCandles(
  candles: Candle[] | null,
  targetSec: number,
  nowSec: number,
  entryPrice: number,
): HorizonState {
  if (!candles) return { state: "pending" };
  if (candles.length === 0) return { state: "na" };
  if (nowSec + 30 < targetSec) return { state: "pending" };
  const covering = candles.find((c) => c.t <= targetSec && targetSec < c.t + 3600);
  if (covering) {
    if (covering.t + 3600 > nowSec + 15) return { state: "pending" };
    return {
      state: "ok",
      price: covering.c,
      ret: ((covering.c - entryPrice) / entryPrice) * 100,
    };
  }
  const last = candles[candles.length - 1];
  if (!last || last.t + 3600 < targetSec) return { state: "na" };
  return { state: "na" };
}

async function pricesFor(mints: string[]): Promise<Map<string, number>> {
  const now = Date.now();
  const fresh = new Map<string, number>(priceCache?.map ?? []);
  const stale = !priceCache || now - priceCache.at >= 30_000;
  const need = [...new Set(mints.filter((m) => stale || !fresh.has(m)))].slice(0, 30);
  if (need.length) {
    const json = await fetchJson(`${GT}/networks/solana/tokens/multi/${need.join(",")}`);
    for (const item of asArray(asRecord(json)?.data)) {
      const attrs = asRecord(asRecord(item)?.attributes);
      const address = typeof attrs?.address === "string" ? attrs.address : "";
      const px = num(attrs?.price_usd);
      if (address && px != null && px > 0) fresh.set(address, px);
    }
    priceCache = { at: now, map: fresh };
  }
  const map = new Map<string, number>();
  for (const mint of mints) {
    const px = fresh.get(mint);
    if (px != null) map.set(mint, px);
  }
  return map;
}

const HOURS = { h1: 1, h4: 4, h24: 24 } as const;

export type QuoteRequest = {
  id: string;
  pool: string;
  mint: string;
  at: number;
  entryPrice: number;
  need: ("h1" | "h4" | "h24")[];
};

export async function runQuote(items: QuoteRequest[]): Promise<QuoteResult> {
  const safe = items
    .filter(
      (item) =>
        isSolanaAddress(item.mint) &&
        isSolanaAddress(item.pool) &&
        item.entryPrice > 0 &&
        Number.isFinite(item.at),
    )
    .slice(0, 20);
  if (!safe.length) return { ok: true, rows: [] };

  let prices = new Map<string, number>();
  try {
    prices = await pricesFor(safe.map((item) => item.mint));
  } catch {
    prices = new Map();
  }

  const rows: QuoteRow[] = [];
  let fetched = 0;
  const nowSec = Date.now() / 1000;
  for (const item of safe) {
    const horizons: QuoteRow["horizons"] = {};
    if (item.need.length === 0) {
      rows.push({ id: item.id, nowPrice: prices.get(item.mint) ?? null, horizons });
      continue;
    }
    if (fetched >= 4) {
      for (const key of item.need) horizons[key] = { state: "pending" };
      rows.push({ id: item.id, nowPrice: prices.get(item.mint) ?? null, horizons });
      continue;
    }
    fetched += 1;
    const candles = await candlesFor(item.pool);
    for (const key of item.need) {
      const target = item.at / 1000 + HOURS[key] * 3600;
      horizons[key] = horizonFromCandles(candles, target, nowSec, item.entryPrice);
    }
    rows.push({ id: item.id, nowPrice: prices.get(item.mint) ?? null, horizons });
  }
  return { ok: true, rows };
}
