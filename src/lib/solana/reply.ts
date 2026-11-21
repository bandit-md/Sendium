import type { JournalEntry, ScanResult } from "@/lib/solana/types";
import { formatUsd } from "@/lib/solana/format";
import { RULES } from "@/lib/solana/metrics";
import {
  coinDetail,
  feedDown,
  formatList,
  formatRoi,
  formatScan,
  helpText,
  roiFooter,
  rulesText,
} from "@/lib/solana/text";

export function answerUser(
  raw: string,
  ctx: {
    scan: ScanResult | undefined;
    journal: JournalEntry[];
    nowPrices?: { mint: string; price: number }[];
  },
): string {
  const text = raw.trim();
  const q = text.toLowerCase().replace(/\s+/g, " ");
  const scan = ctx.scan;
  const now = Date.now();
  const prices = mergePrices(ctx);

  const cmd = commandOf(q);
  if (cmd === "rules") return `${rulesText()}\n\n${footer(prices, ctx.journal, now, scan)}`;
  if (cmd === "help") return `${helpText()}\n\n${footer(prices, ctx.journal, now, scan)}`;
  if (!scan) return "Feed not in yet. No coins listed.";
  if (!scan.ok) return feedDown(scan.error);

  if (cmd === "roi") return formatRoi(ctx.journal, prices, now);
  if (cmd === "scan") return formatScan(scan, scan.coins.slice(0, 8), ctx.journal, prices);
  if (cmd === "buys") {
    return formatList(
      "BUY",
      scan,
      scan.coins.filter((c) => c.signal === "BUY").slice(0, 8),
      ctx.journal,
      prices,
    );
  }
  if (cmd === "watch") {
    return formatList(
      "WATCH",
      scan,
      scan.coins.filter((c) => c.signal === "WATCH").slice(0, 8),
      ctx.journal,
      prices,
    );
  }
  if (cmd === "avoid") {
    return formatList(
      "AVOID",
      scan,
      scan.coins.filter((c) => c.signal === "AVOID").slice(0, 8),
      ctx.journal,
      prices,
    );
  }
  if (cmd === "hot") {
    return formatList(
      "HOT",
      scan,
      scan.coins.filter((c) => c.hot.length > 0).slice(0, 8),
      ctx.journal,
      prices,
    );
  }
  if (cmd === "new") {
    return formatList(
      "NEW < 24h",
      scan,
      scan.coins.filter((c) => c.ageSec != null && c.ageSec < 86_400).slice(0, 8),
      ctx.journal,
      prices,
    );
  }
  if (cmd.startsWith("token:")) {
    const query = cmd.slice("token:".length).trim().toLowerCase();
    const hits = scan.coins.filter((c) => {
      const sym = c.symbol.toLowerCase();
      const label = c.label.toLowerCase();
      return (
        sym === query ||
        label === query ||
        c.mint.toLowerCase() === query ||
        (query.length >= 4 && c.mint.toLowerCase().startsWith(query))
      );
    });
    if (!hits.length) {
      return `No Solana coin around $250k on this pull matches “${query}”.\n\n${footer(prices, ctx.journal, now, scan)}`;
    }
    return `${hits
      .slice(0, 3)
      .map((c) => coinDetail(c))
      .join("\n\n")}\n\n${footer(prices, ctx.journal, now, scan)}`;
  }
  return `Sendium only reads Solana pools from ${formatUsd(RULES.capMin)} to ${formatUsd(RULES.capMax)}. Try /scan, /buys, /hot, /new, /roi.\n\n${footer(prices, ctx.journal, now, scan)}`;
}

function mergePrices(ctx: {
  scan: ScanResult | undefined;
  nowPrices?: { mint: string; price: number }[];
}): { mint: string; price: number }[] {
  const map = new Map<string, number>();
  if (ctx.scan?.ok) {
    for (const coin of ctx.scan.coins) map.set(coin.mint, coin.price);
  }
  for (const row of ctx.nowPrices ?? []) {
    if (row.price > 0) map.set(row.mint, row.price);
  }
  return [...map.entries()].map(([mint, price]) => ({ mint, price }));
}

function footer(
  prices: { mint: string; price: number }[],
  journal: JournalEntry[],
  now: number,
  scan: ScanResult | undefined,
): string {
  if (!scan?.ok) return "ROI · feed down";
  return roiFooter(journal, prices, now);
}

function commandOf(q: string): string {
  if (q.startsWith("/token ") || q.startsWith("token ")) return `token:${q.split(" ").slice(1).join(" ")}`;
  if (q.startsWith("/")) {
    const word = q.slice(1).split(" ")[0] ?? "";
    if (word === "buy") return "buys";
    if (["scan", "buys", "watch", "avoid", "hot", "new", "roi", "rules", "help"].includes(word)) {
      return word;
    }
  }
  if (/(^| )rules?($| )/.test(q)) return "rules";
  if (q === "help" || q.includes("command")) return "help";
  if (q.includes("roi") || q.includes("p&l") || q.includes("pnl")) return "roi";
  if (q.includes("avoid") || q.includes("stay out")) return "avoid";
  if (q.includes("watch")) return "watch";
  if (q.includes("buy")) return "buys";
  if (q.includes("hot") || q.includes("trending") || q.includes("moving") || q.includes("momentum")) {
    return "hot";
  }
  if (q.includes("new")) return "new";
  if (q.includes("scan") || q.includes("rank") || q === "board") return "scan";
  const one = q.replace(/[^a-z0-9._-]/g, "");
  if (one.length >= 2 && one.length <= 16 && !q.includes(" ")) return `token:${q}`;
  return "unknown";
}
