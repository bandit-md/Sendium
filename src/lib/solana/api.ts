import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const quoteItem = z.object({
  id: z.string().min(1).max(80),
  pool: z.string().min(32).max(44),
  mint: z.string().min(32).max(44),
  at: z.number(),
  entryPrice: z.number().positive(),
  need: z.array(z.enum(["h1", "h4", "h24"])).max(3),
});

export const scanSolana = createServerFn({ method: "POST" })
  .validator(z.object({ fresh: z.boolean().optional() }))
  .handler(async ({ data }) => {
    const { runScan } = await import("./scan.server");
    return runScan(data.fresh === true);
  });

export const quoteSignals = createServerFn({ method: "POST" })
  .validator(z.object({ items: z.array(quoteItem).max(20) }))
  .handler(async ({ data }) => {
    const { runQuote } = await import("./scan.server");
    return runQuote(data.items);
  });

const tokenShape = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;

const relayHits = new Map<string, number[]>();

function relayLimited(token: string, max: number): boolean {
  const key = token.slice(-12);
  const now = Date.now();
  const recent = (relayHits.get(key) ?? []).filter((at) => now - at < 60_000);
  if (recent.length >= max) {
    relayHits.set(key, recent);
    return true;
  }
  recent.push(now);
  relayHits.set(key, recent);
  return false;
}

export const pushTelegram = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: z.string().min(20).max(120),
      chatId: z.string().regex(/^-?\d{5,20}$/),
      text: z.string().min(1).max(3900),
    }),
  )
  .handler(async ({ data }) => {
    if (!tokenShape.test(data.token)) return { ok: false as const, error: "Token format looks wrong." };
    if (relayLimited(data.token, 8)) {
      return { ok: false as const, error: "Too many Telegram sends this minute. Wait and retry." };
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${data.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: data.chatId,
          text: data.text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8000),
      });
      const json: unknown = await res.json();
      const rec = json && typeof json === "object" ? (json as { ok?: boolean; description?: string }) : {};
      if (!rec.ok) return { ok: false as const, error: rec.description || "Telegram rejected the message." };
      return { ok: true as const };
    } catch {
      return { ok: false as const, error: "Could not reach Telegram." };
    }
  });

export const findTelegramChats = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string().min(20).max(120) }))
  .handler(async ({ data }) => {
    if (!tokenShape.test(data.token)) return { ok: false as const, error: "Token format looks wrong." };
    if (relayLimited(data.token, 10)) {
      return { ok: false as const, error: "Too many Telegram lookups this minute. Wait and retry." };
    }
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${data.token}/getUpdates?limit=10&timeout=0`,
        { signal: AbortSignal.timeout(8000) },
      );
      const json: unknown = await res.json();
      const rec =
        json && typeof json === "object"
          ? (json as {
              ok?: boolean;
              description?: string;
              result?: { message?: { chat?: { id?: number; title?: string; username?: string; first_name?: string; type?: string } } }[];
            })
          : {};
      if (!rec.ok) return { ok: false as const, error: rec.description || "Telegram rejected the token." };
      const chats = new Map<string, string>();
      for (const update of rec.result ?? []) {
        const chat = update.message?.chat;
        if (!chat || typeof chat.id !== "number") continue;
        const label =
          chat.title ||
          [chat.first_name, chat.username ? `@${chat.username}` : ""].filter(Boolean).join(" ") ||
          String(chat.id);
        chats.set(String(chat.id), label);
      }
      return {
        ok: true as const,
        chats: [...chats.entries()].map(([id, label]) => ({ id, label })),
      };
    } catch {
      return { ok: false as const, error: "Could not reach Telegram." };
    }
  });
