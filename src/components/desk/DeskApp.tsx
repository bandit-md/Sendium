import { useQuery } from "@tanstack/react-query";
import { Copy, RefreshCw, Send, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { findTelegramChats, pushTelegram, quoteSignals, scanSolana } from "@/lib/solana/api";
import { formatAgo, formatCap, formatPct, formatPx, formatUsd, formatUtc } from "@/lib/solana/format";
import { RULES } from "@/lib/solana/metrics";
import {
  applyMarks,
  loadJournal,
  mergeSignals,
  saveJournal,
  toQuoteItems,
  type QuoteItem,
} from "@/lib/solana/journal";
import { answerUser } from "@/lib/solana/reply";
import { formatScan, roiFooter } from "@/lib/solana/text";
import type { Coin, JournalEntry, ScanOk, Signal } from "@/lib/solana/types";

type Pane = "chat" | "rank" | "roi";
type BoardFilter = "all" | "buy" | "watch" | "avoid" | "hot";
type ChatMsg = { id: string; role: "user" | "agent"; text: string; at: number };

const WELCOME: ChatMsg = {
  id: "welcome",
  role: "agent",
  at: 0,
  text: `Sendium. Solana only. Kept only when market cap and FDV are both ${formatUsd(RULES.capMin)}–${formatUsd(RULES.capMax)} (around $250k). No cap on the feed is dropped. Anything outside that band is dropped.\n\n/scan /buys /hot /new /roi /rules`,
};

const TG_KEY = "sendium-tg-v1";

const TEXT: Record<Signal, string> = {
  BUY: "text-buy",
  WATCH: "text-watch",
  AVOID: "text-avoid",
};

const CHIP: Record<Signal, string> = {
  BUY: "bg-buy-dim text-buy",
  WATCH: "bg-watch-dim text-watch",
  AVOID: "bg-avoid-dim text-avoid",
};

const EDGE: Record<Signal, string> = {
  BUY: "border-l-buy",
  WATCH: "border-l-watch",
  AVOID: "border-l-avoid",
};

function Mark() {
  return (
    <span className="relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-md bg-accent text-accent-ink shadow-card">
      <svg viewBox="0 0 32 32" className="size-6" aria-hidden="true">
        <path
          fill="currentColor"
          d="M5.8 16.8 16.2 6.2c.5-.5 1.4-.1 1.4.7v6.4h8.2c.8 0 1.2.9.6 1.5L15.8 25.8c-.5.5-1.4.1-1.4-.7v-6.4H6.4c-.8 0-1.2-.9-.6-1.5Z"
        />
      </svg>
      <span className="absolute inset-x-0 bottom-0 h-1 bg-ice" />
    </span>
  );
}

function fingerprint(scan: ScanOk): string {
  return scan.coins
    .slice(0, 6)
    .map((c) => `${c.mint}:${c.signal}:${c.hot.join("+")}`)
    .join("|");
}

function inBand(coins: Coin[]): Coin[] {
  return coins.filter((c) => {
    const figures = [c.mc, c.fdv].filter((n): n is number => n != null && n > 0);
    if (!figures.length) return false;
    return figures.every((n) => n >= RULES.capMin && n < RULES.capMax);
  });
}

export function DeskApp() {
  const freshRef = useRef(false);
  const journalRef = useRef<JournalEntry[]>([]);
  const idRef = useRef(1);
  const fpRef = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const scanQuery = useQuery({
    queryKey: ["sendium-scan"],
    queryFn: () => {
      const fresh = freshRef.current;
      freshRef.current = false;
      return scanSolana({ data: { fresh } });
    },
    refetchInterval: 45_000,
    staleTime: 15_000,
  });

  const [pane, setPane] = useState<Pane>("chat");
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [openMint, setOpenMint] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([WELCOME]);
  const [draft, setDraft] = useState("");
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [tgOpen, setTgOpen] = useState(false);
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [tgNote, setTgNote] = useState("");
  const [tgBusy, setTgBusy] = useState(false);
  const [chats, setChats] = useState<{ id: string; label: string }[]>([]);

  const scan = scanQuery.data;
  const coins = scan?.ok ? inBand(scan.coins) : [];

  const quote = useQuery({
    queryKey: [
      "sendium-quote",
      journal
        .map((e) => `${e.id}:${e.h1 === undefined ? "u" : "d"}:${e.h4 === undefined ? "u" : "d"}:${e.h24 === undefined ? "u" : "d"}`)
        .join("|"),
    ],
    enabled: hydrated && journal.length > 0,
    staleTime: 20_000,
    refetchInterval: 60_000,
    queryFn: () => quoteSignals({ data: { items: toQuoteItems(journalRef.current) as QuoteItem[] } }),
  });

  const nowPrices = useMemo(() => {
    const map = new Map<string, number>();
    for (const coin of coins) map.set(coin.mint, coin.price);
    if (quote.data?.ok) {
      for (const row of quote.data.rows) {
        const entry = journal.find((e) => e.id === row.id);
        if (entry && row.nowPrice != null && row.nowPrice > 0) map.set(entry.mint, row.nowPrice);
      }
    }
    return [...map.entries()].map(([mint, price]) => ({ mint, price }));
  }, [coins, quote.data, journal]);

  useEffect(() => {
    setJournal(loadJournal());
    try {
      const raw = localStorage.getItem(TG_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { token?: string; chatId?: string };
        if (typeof saved.token === "string") setToken(saved.token);
        if (typeof saved.chatId === "string") setChatId(saved.chatId);
      }
    } catch {
      /* ignore broken local settings */
    }
    setHydrated(true);
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    journalRef.current = journal;
    if (hydrated) saveJournal(journal);
  }, [journal, hydrated]);

  useEffect(() => {
    if (!hydrated || !scan?.ok) return;
    const fp = fingerprint(scan);
    if (fpRef.current === fp) return;
    fpRef.current = fp;
    const next = mergeSignals(journalRef.current, scan.coins, scan.scannedAt);
    const prices = scan.coins.map((c) => ({ mint: c.mint, price: c.price }));
    const text = formatScan(scan, scan.coins.slice(0, 5), next, prices);
    setJournal(next);
    setMessages((prev) =>
      [...prev, { id: nextId(), role: "agent" as const, at: scan.scannedAt, text }].slice(-30),
    );
  }, [hydrated, scan]);

  useEffect(() => {
    if (!quote.data?.ok) return;
    const rows = quote.data.rows;
    setJournal((prev) => applyMarks(prev, rows));
  }, [quote.data]);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    endRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "end" });
  }, [messages.length, pane]);

  function nextId() {
    idRef.current += 1;
    return `m${idRef.current}`;
  }

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const at = Date.now();
    const reply = answerUser(trimmed, { scan, journal, nowPrices });
    setMessages((prev) =>
      [
        ...prev,
        { id: nextId(), role: "user" as const, at, text: trimmed },
        { id: nextId(), role: "agent" as const, at, text: reply },
      ].slice(-30),
    );
    setDraft("");
  }

  async function refresh() {
    freshRef.current = true;
    await scanQuery.refetch();
  }

  async function copyText(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied((cur) => (cur === id ? null : cur)), 1500);
    } catch {
      setCopied(null);
      setTgNote("Copy failed in this browser.");
      setTgOpen(true);
    }
  }

  function saveTg() {
    localStorage.setItem(TG_KEY, JSON.stringify({ token, chatId }));
    setTgNote("Saved in this browser only.");
  }

  async function lookupChats() {
    setTgBusy(true);
    setTgNote("");
    const result = await findTelegramChats({ data: { token } });
    setTgBusy(false);
    if (!result.ok) {
      setTgNote(result.error);
      return;
    }
    setChats(result.chats);
    if (!result.chats.length) setTgNote("No chats yet. Send the bot any message, then try again.");
  }

  async function pushLast() {
    const last = [...messages].reverse().find((m) => m.role === "agent");
    if (!last) return;
    if (!token || !chatId) {
      setTgOpen(true);
      setTgNote("Add the bot token and chat id first.");
      return;
    }
    setTgBusy(true);
    setTgNote("");
    const parts = chunk(last.text);
    for (const part of parts) {
      const result = await pushTelegram({ data: { token, chatId, text: part } });
      if (!result.ok) {
        setTgBusy(false);
        setTgNote(result.error);
        setTgOpen(true);
        return;
      }
    }
    setTgBusy(false);
    setTgNote(`Sent ${parts.length} message${parts.length === 1 ? "" : "s"}.`);
    setTgOpen(true);
  }

  const filtered = coins.filter((c) => {
    if (filter === "buy") return c.signal === "BUY";
    if (filter === "watch") return c.signal === "WATCH";
    if (filter === "avoid") return c.signal === "AVOID";
    if (filter === "hot") return c.hot.length > 0;
    return true;
  });

  const counts = {
    all: coins.length,
    buy: coins.filter((c) => c.signal === "BUY").length,
    watch: coins.filter((c) => c.signal === "WATCH").length,
    avoid: coins.filter((c) => c.signal === "AVOID").length,
    hot: coins.filter((c) => c.hot.length > 0).length,
  };

  const chatClass = pane === "chat" ? "flex" : "hidden md:flex";
  const sideClass = pane === "chat" ? "hidden md:flex" : "flex";
  const sideMode: "rank" | "roi" = pane === "roi" ? "roi" : "rank";

  return (
    <main className="relative flex h-dvh flex-col text-fg">
      <header className="shrink-0">
        <div className="flex items-center gap-3 bg-surface/80 px-3 py-3 backdrop-blur-md md:px-5">
          <Mark />
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold tracking-tight text-fg">Sendium</h1>
            <p className="truncate text-xs text-muted">Solana · around $250k cap and FDV</p>
          </div>
          <div className="hidden items-center gap-3 sm:flex">
            <span
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1 font-mono text-xs ${
                scan?.ok ? "bg-buy-dim text-buy" : "bg-surface-2 text-muted"
              }`}
            >
              <span className={`size-1.5 rounded-full ${scan?.ok ? "live-dot bg-buy" : "bg-muted"}`} />
              {scan?.ok ? "LIVE" : scanQuery.isError || scan?.ok === false ? "OFF" : "WAIT"}
            </span>
            <span className="font-mono text-xs text-muted tabular-nums">{now ? formatUtc(now) : "—"}</span>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex min-h-11 items-center gap-2 rounded-md bg-surface px-3 text-sm text-fg shadow-card transition duration-150 ease-out hover:shadow-lift active:scale-95"
          >
            <RefreshCw className={`size-4 ${scanQuery.isFetching ? "motion-safe:animate-spin" : ""}`} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
          <button
            type="button"
            onClick={() => void pushLast()}
            className="inline-flex min-h-11 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-ink shadow-card transition-transform duration-150 ease-out active:scale-95"
          >
            <Send className="size-4" />
            <span className="hidden sm:inline">Telegram</span>
          </button>
        </div>
        <div className="brand-rule" />
      </header>

      <div className="flex min-h-0 flex-1">
        <section className={`${chatClass} min-h-0 w-full min-w-0 flex-col bg-surface/70 md:w-96 md:shrink-0 md:border-r md:border-line`}>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-4 md:px-4">
            {messages.map((msg) =>
              msg.role === "user" ? (
                <p
                  key={msg.id}
                  className="ml-auto max-w-4/5 rounded-lg bg-accent px-3 py-2 text-sm text-accent-ink shadow-card"
                >
                  {msg.text}
                </p>
              ) : (
                <article key={msg.id} className="max-w-full">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-muted">Sendium{msg.at ? ` · ${formatUtc(msg.at)}` : ""}</span>
                    <button
                      type="button"
                      onClick={() => void copyText(msg.id, msg.text)}
                      className="inline-flex min-h-11 items-center gap-1 px-2 text-xs text-muted"
                    >
                      <Copy className="size-3.5" />
                      {copied === msg.id ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <pre className="max-w-full overflow-x-hidden rounded-lg bg-surface p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-fg shadow-card">
                    {msg.text}
                  </pre>
                </article>
              ),
            )}
            <div ref={endRef} />
          </div>
          <form
            className="shrink-0 border-t border-line bg-surface/90 p-3 backdrop-blur-md"
            onSubmit={(event) => {
              event.preventDefault();
              send(draft);
            }}
          >
            <div className="mb-2 flex flex-wrap gap-2">
              {(["scan", "buys", "hot", "new", "roi", "rules"] as const).map((cmd) => (
                <button
                  key={cmd}
                  type="button"
                  onClick={() => send(`/${cmd}`)}
                  className="min-h-11 rounded-full bg-surface px-3 font-mono text-xs text-fg shadow-card transition duration-150 ease-out hover:shadow-lift"
                >
                  /{cmd}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Symbol, /scan, /roi"
                className="min-h-11 min-w-0 flex-1 rounded-md border border-line bg-surface px-3 text-sm text-fg placeholder:text-muted"
                aria-label="Message the desk"
              />
              <button
                type="submit"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md bg-accent px-3 text-accent-ink shadow-card transition-transform duration-150 ease-out active:scale-95"
                aria-label="Send"
              >
                <Send className="size-4" />
              </button>
            </div>
            <p className="mt-2 text-xs text-muted">Not advice. Every figure comes from the pool feed.</p>
          </form>
        </section>

        <section className={`${sideClass} min-h-0 min-w-0 flex-1 flex-col`}>
          <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-3 md:px-5">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPane("rank")}
                className={`min-h-11 rounded-full px-4 text-sm ${sideMode === "rank" ? "bg-accent text-accent-ink shadow-card" : "bg-surface text-fg shadow-card"}`}
              >
                Rank
              </button>
              <button
                type="button"
                onClick={() => setPane("roi")}
                className={`min-h-11 rounded-full px-4 text-sm ${sideMode === "roi" ? "bg-accent text-accent-ink shadow-card" : "bg-surface text-fg shadow-card"}`}
              >
                ROI
              </button>
            </div>
            <p className="truncate font-mono text-xs text-muted">
              {scan?.ok
                ? `top ${coins.length} of ${scan.kept} · ${scan.droppedHighCap + scan.droppedLowCap} outside band`
                : scan && !scan.ok
                  ? "Feed down"
                  : "Reading pools"}
            </p>
          </div>

          {sideMode === "rank" ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="flex flex-wrap gap-2 px-3 pb-2 md:px-5">
                {(
                  [
                    ["all", "All"],
                    ["buy", "Buy"],
                    ["watch", "Watch"],
                    ["avoid", "Avoid"],
                    ["hot", "Hot"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setFilter(id)}
                    className={`min-h-11 rounded-full px-3 font-mono text-xs ${filter === id ? "bg-accent text-accent-ink shadow-card" : "bg-surface text-fg shadow-card"}`}
                  >
                    {label} {counts[id]}
                  </button>
                ))}
              </div>
              {scan && !scan.ok ? (
                <p className="px-5 font-mono text-sm text-avoid">{scan.error} Nothing listed.</p>
              ) : null}
              {!scan && scanQuery.isPending ? (
                <p className="px-5 font-mono text-sm text-muted">Reading Solana pools around $250k.</p>
              ) : null}
              {scan?.ok && filtered.length === 0 ? (
                <p className="px-5 font-mono text-sm text-muted">None in the $150k–$400k band in this cut.</p>
              ) : null}
              <ul className="space-y-2 px-3 pb-4 md:px-5">
                {filtered.map((coin, index) => (
                  <li key={coin.mint} className="overflow-hidden rounded-lg bg-surface shadow-card">
                    <button
                      type="button"
                      onClick={() => setOpenMint((cur) => (cur === coin.mint ? null : coin.mint))}
                      className={`block w-full border-l-2 px-3 py-3 text-left transition duration-150 ease-out hover:shadow-lift ${coin.hot.length ? EDGE[coin.signal] : "border-l-transparent"}`}
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <div className="flex min-w-0 items-baseline gap-2">
                          <span className="font-mono text-xs text-muted tabular-nums">{index + 1}</span>
                          <span className="truncate font-semibold text-fg">{coin.label}</span>
                        </div>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-xs ${CHIP[coin.signal]}`}>
                          {coin.signal}
                        </span>
                      </div>
                      <p className="mt-1 font-mono text-xs text-muted tabular-nums">
                        {formatPx(coin.price)} · {formatCap(coin)} · liq {formatUsd(coin.liq)}
                      </p>
                      <p className="mt-1 font-mono text-xs tabular-nums text-fg">
                        <span className={coin.change.h1 != null && coin.change.h1 < 0 ? "text-avoid" : "text-buy"}>
                          1h {formatPct(coin.change.h1)}
                        </span>
                        <span className="text-muted"> · 24h {formatPct(coin.change.h24)} · vol {formatUsd(coin.vol.h1)}</span>
                      </p>
                      {coin.hot.length ? (
                        <p className="mt-1 font-mono text-xs text-accent">{coin.hot.join(" · ")}</p>
                      ) : null}
                    </button>
                    {openMint === coin.mint ? <Dossier coin={coin} /> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <RoiPane journal={journal} nowPrices={nowPrices} now={now} quoteNote={quoteNote(quote.data, quote.isError)} />
          )}
        </section>
      </div>

      <nav className="grid shrink-0 grid-cols-3 border-t border-line bg-surface/90 backdrop-blur-md md:hidden">
        {(
          [
            ["chat", "Chat"],
            ["rank", "Rank"],
            ["roi", "ROI"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={pane === id}
            onClick={() => setPane(id)}
            className={`min-h-12 text-sm ${pane === id ? "font-semibold text-accent" : "text-muted"}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tgOpen ? (
        <div className="absolute inset-0 z-20 flex items-end bg-fg/35 backdrop-blur-sm md:items-center md:justify-center">
          <div className="max-h-full w-full overflow-y-auto rounded-t-lg bg-surface p-5 shadow-lift md:max-w-md md:rounded-lg">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold tracking-tight">Send to Telegram</h2>
              <button type="button" onClick={() => setTgOpen(false)} className="inline-flex size-11 items-center justify-center text-muted" aria-label="Close">
                <X className="size-5" />
              </button>
            </div>
            <p className="mb-4 text-sm leading-relaxed text-muted">
              Token stays in this browser. Sendium posts the last desk message as plain text. Not stored on the server.
            </p>
            <label className="mb-2 block text-xs text-muted" htmlFor="tg-token">
              Bot token
            </label>
            <input
              id="tg-token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
              className="mb-3 min-h-11 w-full rounded-md border border-line bg-surface-2 px-3 font-mono text-sm text-fg"
            />
            <label className="mb-2 block text-xs text-muted" htmlFor="tg-chat">
              Chat id
            </label>
            <input
              id="tg-chat"
              value={chatId}
              onChange={(event) => setChatId(event.target.value)}
              inputMode="numeric"
              className="mb-4 min-h-11 w-full rounded-md border border-line bg-surface-2 px-3 font-mono text-sm text-fg"
            />
            <div className="mb-3 flex flex-wrap gap-2">
              <button type="button" onClick={saveTg} className="min-h-11 rounded-md bg-surface px-3 text-sm shadow-card">
                Save
              </button>
              <button
                type="button"
                onClick={() => void lookupChats()}
                disabled={tgBusy}
                className="min-h-11 rounded-md bg-surface px-3 text-sm shadow-card disabled:opacity-50"
              >
                Find chats
              </button>
              <button
                type="button"
                onClick={() => void pushLast()}
                disabled={tgBusy}
                className="min-h-11 rounded-md bg-accent px-3 text-sm font-medium text-accent-ink shadow-card disabled:opacity-50"
              >
                Send last
              </button>
            </div>
            {chats.length ? (
              <ul className="mb-3 space-y-2">
                {chats.map((chat) => (
                  <li key={chat.id}>
                    <button
                      type="button"
                      onClick={() => setChatId(chat.id)}
                      className="flex min-h-11 w-full items-center justify-between rounded-md bg-surface-2 px-3 text-left text-sm"
                    >
                      <span className="truncate">{chat.label}</span>
                      <span className="ml-2 font-mono text-xs text-muted">{chat.id}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {tgNote ? <p className="font-mono text-xs text-muted">{tgNote}</p> : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}

function quoteNote(
  data: { ok: true; rows: unknown[] } | { ok: false; error: string } | undefined,
  isError: boolean,
): string | null {
  if (isError) return "Candle feed busy. Marks stay blank until it answers.";
  if (data && !data.ok) return data.error;
  return null;
}

function Dossier({ coin }: { coin: Coin }) {
  const buyPct = coin.pressure == null ? 0 : Math.round(coin.pressure * 100);
  return (
    <div className="border-t border-line bg-surface-2 px-3 py-3 font-mono text-xs leading-relaxed text-fg">
      <p className="text-muted">
        {coin.name} · {coin.dex} · age {coin.ageSec == null ? "n/a" : formatAgeSafe(coin.ageSec)}
      </p>
      <p className="mt-2">{coin.why}</p>
      {coin.txH1 ? (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-muted">
            <span>1h buys {buyPct}%</span>
            <span>
              {coin.txH1.buys}/{coin.txH1.sells}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-line">
            <div className="h-1 rounded-full bg-buy" style={{ width: `${buyPct}%` }} />
          </div>
        </div>
      ) : (
        <p className="mt-2 text-muted">1h buys/sells n/a</p>
      )}
      {coin.entry ? (
        <p className="mt-3">
          Entry {formatPx(coin.entry.price)} · chase cap {formatPx(coin.entry.chaseAbove)} · stop{" "}
          {formatPx(coin.entry.invalidPrice)} or liq under {formatUsd(coin.entry.invalidLiq)} · 1% liq ≈{" "}
          {formatUsd(coin.entry.clipUsd)}
        </p>
      ) : (
        <p className="mt-3 text-muted">No entry.</p>
      )}
      <p className="mt-2 break-all text-muted">{coin.mint}</p>
      <a
        className="mt-2 inline-flex min-h-11 items-center text-accent"
        href={`https://dexscreener.com/solana/${coin.mint}`}
        target="_blank"
        rel="noreferrer"
      >
        DexScreener
      </a>
    </div>
  );
}

function formatAgeSafe(sec: number): string {
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m`;
  if (sec < 86_400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86_400).toFixed(1)}d`;
}

function RoiPane({
  journal,
  nowPrices,
  now,
  quoteNote: note,
}: {
  journal: JournalEntry[];
  nowPrices: { mint: string; price: number }[];
  now: number | null;
  quoteNote: string | null;
}) {
  const priceOf = new Map(nowPrices.map((row) => [row.mint, row.price]));
  const clock = now ?? 0;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 md:px-5">
      <p className="mb-3 font-mono text-xs leading-relaxed text-muted">
        {now ? roiFooter(journal, nowPrices, clock) : "ROI loads with the journal."}
      </p>
      <p className="mb-3 text-xs text-muted">
        1h / 4h / 24h use the hour-candle close after the signal. Pending until that candle closes. Now waits 5 minutes so a fresh log is not a fake 0%.
      </p>
      {note ? <p className="mb-3 font-mono text-xs text-watch">{note}</p> : null}
      <ul className="space-y-2">
        {journal.map((entry) => {
          const px = priceOf.get(entry.mint);
          const nowRet = px != null && px > 0 ? ((px - entry.entryPrice) / entry.entryPrice) * 100 : null;
          return (
            <li key={entry.id} className="rounded-lg bg-surface px-3 py-3 shadow-card">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">{entry.symbol}</span>
                <span className={`font-mono text-xs ${TEXT[entry.signal]}`}>{entry.signal}</span>
              </div>
              <p className="mt-1 font-mono text-xs text-muted tabular-nums">
                {entry.capLabel} · liq {formatUsd(entry.liq)} · {now ? formatAgo(entry.at, now) : "—"}
              </p>
              <p className="mt-1 font-mono text-xs tabular-nums">
                {formatPx(entry.entryPrice)} → {px != null ? formatPx(px) : "n/a"}{" "}
                {nowRet == null || (now != null && now - entry.at < 5 * 60 * 1000) ? (
                  <span className="text-muted">just logged</span>
                ) : (
                  <span className={nowRet < 0 ? "text-avoid" : "text-buy"}>{formatPct(nowRet)}</span>
                )}
              </p>
              <p className="mt-1 font-mono text-xs text-muted tabular-nums">
                {markText(entry, "h1", 1, clock)} · {markText(entry, "h4", 4, clock)} · {markText(entry, "h24", 24, clock)}
              </p>
            </li>
          );
        })}
      </ul>
      {journal.length === 0 ? (
        <p className="font-mono text-sm text-muted">No signals stored yet. BUY and hot WATCH prints are logged on each scan.</p>
      ) : null}
    </div>
  );
}

function markText(entry: JournalEntry, key: "h1" | "h4" | "h24", hours: number, now: number): string {
  const mark = entry[key];
  if (mark && typeof mark === "object") return `${key} ${formatPct(mark.ret)}`;
  if (now - entry.at < hours * 3_600_000) return `${key} pending`;
  if (mark === null) return `${key} n/a`;
  return `${key} …`;
}

function chunk(text: string): string[] {
  if (text.length <= 3500) return [text];
  const parts: string[] = [];
  let buf = "";
  for (const block of text.split("\n\n")) {
    const next = buf ? `${buf}\n\n${block}` : block;
    if (next.length > 3500 && buf) {
      parts.push(buf);
      buf = block.slice(0, 3500);
    } else {
      buf = next;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}
