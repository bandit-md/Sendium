import { formatCap } from "@/lib/solana/format";
import type { Coin, JournalEntry, Mark, QuoteRow } from "@/lib/solana/types";

const KEY = "sendium-journal-v1";
const MAX = 40;
const DEDUPE_MS = 6 * 60 * 60 * 1000;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function readMark(v: unknown): Mark | null | undefined {
  if (v === null) return null;
  if (v === undefined) return undefined;
  const o = asRecord(v);
  if (!o || typeof o.price !== "number" || typeof o.ret !== "number") return undefined;
  if (!Number.isFinite(o.price) || !Number.isFinite(o.ret) || o.price <= 0) return undefined;
  return { price: o.price, ret: o.ret };
}

function isEntry(v: unknown): JournalEntry | null {
  const o = asRecord(v);
  if (!o) return null;
  if (typeof o.id !== "string" || typeof o.mint !== "string" || typeof o.pool !== "string") {
    return null;
  }
  if (typeof o.symbol !== "string" || typeof o.capLabel !== "string") return null;
  if (o.signal !== "BUY" && o.signal !== "WATCH") return null;
  if (typeof o.entryPrice !== "number" || !(o.entryPrice > 0)) return null;
  if (typeof o.at !== "number" || typeof o.liq !== "number") return null;
  const entry: JournalEntry = {
    id: o.id,
    mint: o.mint,
    pool: o.pool,
    symbol: o.symbol,
    signal: o.signal,
    entryPrice: o.entryPrice,
    capLabel: o.capLabel,
    liq: o.liq,
    at: o.at,
  };
  if ("h1" in o) entry.h1 = readMark(o.h1);
  if ("h4" in o) entry.h4 = readMark(o.h4);
  if ("h24" in o) entry.h24 = readMark(o.h24);
  return entry;
}

export function loadJournal(): JournalEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(isEntry).filter((e): e is JournalEntry => e != null).slice(0, MAX);
  } catch {
    return [];
  }
}

export function saveJournal(entries: JournalEntry[]) {
  localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX)));
}

export function mergeSignals(prev: JournalEntry[], coins: Coin[], now: number): JournalEntry[] {
  const next = [...prev];
  for (const c of coins) {
    const track = c.signal === "BUY" || (c.signal === "WATCH" && c.hot.length > 0);
    if (!track || c.signal === "AVOID") continue;
    const signal = c.signal;
    const dup = next.some(
      (e) => e.mint === c.mint && e.signal === c.signal && now - e.at < DEDUPE_MS,
    );
    if (dup) continue;
    next.unshift({
      id: `${c.mint.slice(0, 8)}-${c.signal}-${now}`,
      mint: c.mint,
      pool: c.pool,
      symbol: c.label,
      signal,
      entryPrice: c.price,
      capLabel: formatCap(c),
      liq: c.liq,
      at: now,
    });
  }
  return next.slice(0, MAX);
}

export function applyMarks(prev: JournalEntry[], rows: QuoteRow[]): JournalEntry[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  let changed = false;
  const next = prev.map((e) => {
    const row = byId.get(e.id);
    if (!row) return e;
    let cur = e;
    for (const key of ["h1", "h4", "h24"] as const) {
      if (cur[key] !== undefined) continue;
      const horizon = row.horizons[key];
      if (!horizon || horizon.state === "pending") continue;
      changed = true;
      cur = {
        ...cur,
        [key]: horizon.state === "ok" ? { price: horizon.price, ret: horizon.ret } : null,
      };
    }
    return cur;
  });
  return changed ? next : prev;
}

export type QuoteItem = {
  id: string;
  pool: string;
  mint: string;
  at: number;
  entryPrice: number;
  need: ("h1" | "h4" | "h24")[];
};

export function toQuoteItems(entries: JournalEntry[]): QuoteItem[] {
  const due = new Set<string>();
  const oldest = [...entries].sort((a, b) => a.at - b.at);
  let slots = 0;
  for (const e of oldest) {
    if (slots >= 4) break;
    const age = Date.now() - e.at;
    const waiting =
      (age >= 3_600_000 && e.h1 === undefined) ||
      (age >= 4 * 3_600_000 && e.h4 === undefined) ||
      (age >= 24 * 3_600_000 && e.h24 === undefined);
    if (!waiting) continue;
    due.add(e.id);
    slots += 1;
  }
  return entries.slice(0, 20).map((e) => {
    const age = Date.now() - e.at;
    const need: QuoteItem["need"] = [];
    if (due.has(e.id)) {
      if (age >= 3_600_000 && e.h1 === undefined) need.push("h1");
      if (age >= 4 * 3_600_000 && e.h4 === undefined) need.push("h4");
      if (age >= 24 * 3_600_000 && e.h24 === undefined) need.push("h24");
    }
    return {
      id: e.id,
      pool: e.pool,
      mint: e.mint,
      at: e.at,
      entryPrice: e.entryPrice,
      need,
    };
  });
}
