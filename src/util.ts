import { homedir } from "node:os";
import { join, basename } from "node:path";

/**
 * Every Claude Code config root we can find, so sessions are indexed no matter
 * which directory (or config dir) they were started from. Extra roots can be
 * added with CCX_CLAUDE_DIRS (colon-separated).
 */
export function claudeDirs(): string[] {
  const candidates = [
    ...(process.env.CCX_CLAUDE_DIRS?.split(":") ?? []),
    process.env.CLAUDE_CONFIG_DIR,
    join(homedir(), ".claude"),
    join(homedir(), ".config", "claude"),
  ];
  const seen = new Set<string>();
  return candidates.filter((d): d is string => {
    if (!d || seen.has(d)) return false;
    seen.add(d);
    return true;
  });
}

export const ccxDir = () => process.env.CCX_DIR ?? join(homedir(), ".ccx");

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const ansi = (code: string) => (s: string) =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

export const bold = ansi("1");
export const dim = ansi("2");
export const cyan = ansi("36");
export const green = ansi("32");
export const yellow = ansi("33");
export const magenta = ansi("35");
export const red = ansi("31");

/** "2w" | "3d" | "12h" | "1m" (months) | ISO date -> ISO timestamp string */
export function parseWhen(s: string): string {
  const m = s.match(/^(\d+)([hdwm])$/);
  if (m) {
    const n = Number(m[1]);
    const unitMs: Record<string, number> = {
      h: 3600_000,
      d: 86400_000,
      w: 7 * 86400_000,
      m: 30 * 86400_000,
    };
    return new Date(Date.now() - n * unitMs[m[2]!]!).toISOString();
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Cannot parse time "${s}" (use e.g. 12h, 3d, 2w, 1m, or a date)`);
  }
  return d.toISOString();
}

export function fmtDate(ts: string | null | undefined): string {
  if (!ts) return "?";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "?";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Human-friendly project label: prefer cwd basename, else tail of the slug. */
export function projectLabel(slug: string, cwd?: string | null): string {
  if (cwd) return basename(cwd);
  return slug.replace(/^-Users-[^-]+-?/, "") || slug;
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + dim(` … (+${s.length - n} chars)`);
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
