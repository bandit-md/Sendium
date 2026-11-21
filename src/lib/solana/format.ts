export function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) {
    const millions = abs / 1_000_000;
    const digits = millions >= 10 ? (Number.isInteger(millions) ? 0 : 1) : 2;
    return `${sign}$${millions.toFixed(digits)}M`;
  }
  if (abs >= 100_000) return `${sign}$${Math.round(abs / 1000)}k`;
  if (abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  if (abs >= 1_000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  if (abs >= 1) return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toPrecision(3)}`;
}

export function formatPx(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 100) return `$${n.toFixed(2)}`;
  if (n >= 1) return `$${n.toFixed(4)}`;
  const digits = Math.min(12, Math.max(4, Math.ceil(-Math.log10(n)) + 3));
  return `$${n.toFixed(digits)}`;
}

export function formatPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

export function formatAge(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "n/a";
  if (sec < 90) return `${Math.max(1, Math.round(sec))}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86_400) {
    const h = sec / 3600;
    return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  }
  return `${(sec / 86_400).toFixed(1)}d`;
}

export function formatUtc(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

export function formatAgo(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = s / 3600;
  if (h < 36) return `${h.toFixed(h < 10 ? 1 : 0)}h ago`;
  return `${(h / 24).toFixed(1)}d ago`;
}

export function formatCap(input: {
  mc: number | null;
  fdv: number | null;
  cap: number;
  capKind: "mc" | "fdv";
}): string {
  if (
    input.mc != null &&
    input.fdv != null &&
    input.fdv > 0 &&
    Math.abs(input.mc - input.fdv) / input.fdv > 0.15
  ) {
    return `MC ${formatUsd(input.mc)} · FDV ${formatUsd(input.fdv)}`;
  }
  return input.capKind === "mc" ? `MC ${formatUsd(input.cap)}` : `FDV ${formatUsd(input.cap)}`;
}
