export const CAP_MIN_USD = 150_000;
export const CAP_MAX_USD = 400_000;

export type Signal = "BUY" | "WATCH" | "AVOID";

export type HotTag = "vol spike" | "momentum" | "new" | "buy pressure";

export type EntryPlan = {
  price: number;
  chaseAbove: number;
  invalidPrice: number;
  invalidLiq: number;
  clipUsd: number;
};

export type Coin = {
  mint: string;
  pool: string;
  symbol: string;
  label: string;
  name: string;
  dex: string;
  price: number;
  mc: number | null;
  fdv: number | null;
  cap: number;
  capKind: "mc" | "fdv";
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
  pressure: number | null;
  spike: number | null;
  hot: HotTag[];
  signal: Signal;
  why: string;
  entry: EntryPlan | null;
  lists: string[];
};

export type ScanOk = {
  ok: true;
  scannedAt: number;
  source: string;
  unique: number;
  droppedHighCap: number;
  droppedLowCap: number;
  droppedUnknownCap: number;
  kept: number;
  coins: Coin[];
};

export type ScanErr = {
  ok: false;
  scannedAt: number;
  error: string;
};

export type ScanResult = ScanOk | ScanErr;

export type Mark = { price: number; ret: number };

export type JournalEntry = {
  id: string;
  mint: string;
  pool: string;
  symbol: string;
  signal: "BUY" | "WATCH";
  entryPrice: number;
  capLabel: string;
  liq: number;
  at: number;
  h1?: Mark | null;
  h4?: Mark | null;
  h24?: Mark | null;
};

export type HorizonState =
  | { state: "ok"; price: number; ret: number }
  | { state: "pending" }
  | { state: "na" };

export type QuoteRow = {
  id: string;
  nowPrice: number | null;
  horizons: {
    h1?: HorizonState;
    h4?: HorizonState;
    h24?: HorizonState;
  };
};

export type QuoteResult =
  | { ok: true; rows: QuoteRow[] }
  | { ok: false; error: string };
