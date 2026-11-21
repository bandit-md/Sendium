export type Candidate = {
  mint: string;
  pool: string;
  symbol: string;
  name: string;
  dex: string;
  price: number;
  mc: number | null;
  fdv: number | null;
  liq: number;
  ageSec: number | null;
  change: {
    m5: number | null;
    h1: number | null;
    h6: number | null;
    h24: number | null;
  };
  vol: {
    m5: number | null;
    h1: number | null;
    h6: number | null;
    h24: number | null;
  };
  txH1: { buys: number; sells: number } | null;
  txH24: { buys: number; sells: number } | null;
  lists: string[];
};

export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function cleanSymbol(raw: string): string {
  return raw.replace(/^\$/, "").split("/")[0]?.trim().slice(0, 24) ?? "";
}

function txPair(v: unknown): { buys: number; sells: number } | null {
  const rec = asRecord(v);
  if (!rec) return null;
  const buys = num(rec.buys);
  const sells = num(rec.sells);
  if (buys == null || sells == null) return null;
  return { buys, sells };
}

export function parseGtPayload(json: unknown, list: string): Candidate[] {
  const root = asRecord(json);
  if (!root) return [];
  const tokens = new Map<string, { symbol: string; name: string; address: string }>();
  for (const item of asArray(root.included)) {
    const rec = asRecord(item);
    if (!rec || rec.type !== "token") continue;
    const attrs = asRecord(rec.attributes);
    if (!attrs || typeof rec.id !== "string") continue;
    tokens.set(rec.id, {
      symbol: typeof attrs.symbol === "string" ? attrs.symbol : "",
      name: typeof attrs.name === "string" ? attrs.name : "",
      address: typeof attrs.address === "string" ? attrs.address : "",
    });
  }

  const out: Candidate[] = [];
  for (const item of asArray(root.data)) {
    const pool = asRecord(item);
    if (!pool) continue;
    const attrs = asRecord(pool.attributes);
    const rels = asRecord(pool.relationships);
    if (!attrs) continue;
    const baseRel = asRecord(asRecord(rels?.base_token)?.data);
    const relId = typeof baseRel?.id === "string" ? baseRel.id : "";
    const tok = relId ? tokens.get(relId) : undefined;
    const mint =
      tok?.address || (relId.startsWith("solana_") ? relId.slice("solana_".length) : "");
    const rawName = typeof attrs.name === "string" ? attrs.name : "";
    const symbol = cleanSymbol(tok?.symbol || rawName.split("/")[0] || "");
    const price = num(attrs.base_token_price_usd);
    const poolAddr = typeof attrs.address === "string" ? attrs.address : "";
    if (!mint || !isSolanaAddress(mint) || !symbol || price == null || !isSolanaAddress(poolAddr)) continue;
    const created =
      typeof attrs.pool_created_at === "string" ? Date.parse(attrs.pool_created_at) : NaN;
    const ageSec = Number.isFinite(created)
      ? Math.max(0, (Date.now() - created) / 1000)
      : null;
    const vol = asRecord(attrs.volume_usd);
    const ch = asRecord(attrs.price_change_percentage);
    const txs = asRecord(attrs.transactions);
    const dexRel = asRecord(asRecord(rels?.dex)?.data);
    out.push({
      mint,
      pool: poolAddr,
      symbol,
      name: tok?.name || symbol,
      dex: typeof dexRel?.id === "string" ? dexRel.id : "unknown",
      price,
      mc: num(attrs.market_cap_usd),
      fdv: num(attrs.fdv_usd),
      liq: num(attrs.reserve_in_usd) ?? 0,
      ageSec,
      change: {
        m5: num(ch?.m5),
        h1: num(ch?.h1),
        h6: num(ch?.h6),
        h24: num(ch?.h24),
      },
      vol: {
        m5: num(vol?.m5),
        h1: num(vol?.h1),
        h6: num(vol?.h6),
        h24: num(vol?.h24),
      },
      txH1: txPair(txs?.h1),
      txH24: txPair(txs?.h24),
      lists: [list],
    });
  }
  return out;
}

function pairList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  const rec = asRecord(v);
  if (rec && Array.isArray(rec.pairs)) return rec.pairs;
  return [];
}

export function parseDexPayload(json: unknown, list: string): Candidate[] {
  const out: Candidate[] = [];
  for (const item of pairList(json)) {
    const p = asRecord(item);
    if (!p || p.chainId !== "solana") continue;
    const base = asRecord(p.baseToken);
    const mint = typeof base?.address === "string" ? base.address : "";
    const symbol = cleanSymbol(typeof base?.symbol === "string" ? base.symbol : "");
    const price = num(p.priceUsd);
    const pool = typeof p.pairAddress === "string" ? p.pairAddress : "";
    if (!mint || !isSolanaAddress(mint) || !symbol || price == null || !isSolanaAddress(pool)) continue;
    const created = num(p.pairCreatedAt);
    const ageSec =
      created != null && created > 0 ? Math.max(0, (Date.now() - created) / 1000) : null;
    const vol = asRecord(p.volume);
    const ch = asRecord(p.priceChange);
    const txns = asRecord(p.txns);
    const liq = asRecord(p.liquidity);
    out.push({
      mint,
      pool,
      symbol,
      name: typeof base?.name === "string" ? base.name : symbol,
      dex: typeof p.dexId === "string" ? p.dexId : "unknown",
      price,
      mc: num(p.marketCap),
      fdv: num(p.fdv),
      liq: num(liq?.usd) ?? 0,
      ageSec,
      change: {
        m5: num(ch?.m5),
        h1: num(ch?.h1),
        h6: num(ch?.h6),
        h24: num(ch?.h24),
      },
      vol: {
        m5: num(vol?.m5),
        h1: num(vol?.h1),
        h6: num(vol?.h6),
        h24: num(vol?.h24),
      },
      txH1: txPair(txns?.h1),
      txH24: txPair(txns?.h24),
      lists: [list],
    });
  }
  return out;
}

export function isSolanaAddress(value: string): boolean {
  return BASE58.test(value);
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
