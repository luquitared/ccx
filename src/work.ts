/**
 * `ccx work`: open items grouped by workstream, kept by the agents doing the work.
 *
 * Lives in its own database (~/.ccx/work.db). The search index can always be rebuilt
 * from transcripts; this can't, so it never shares a file with it.
 *
 * A workstream is a line of work that outlives any one session or folder. An item is
 * something still open in it, with whoever holds the ball: `me`, `agent`, or a person's
 * name. Items point back at the session they came from, and can carry a check that
 * closes them when the outside world says they're finished.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openDb } from "./db.ts";
import { runIndex } from "./indexer.ts";
import { bold, ccxDir, cyan, dim, green, magenta, oneLine, parseWhen, printOut, projectLabel, red, yellow } from "./util.ts";

const KINDS = ["do", "decide", "verify", "risk"] as const;
const PRIORITIES = ["high", "med", "low"] as const;
const STREAM_STATUSES = ["active", "parked", "done"] as const;
const STALE_DAYS = 7;
const SETTLE_MINUTES = 30;
const DAY = 86400_000;

export class WorkError extends Error {
  constructor(message: string, public code = 1, public detail?: unknown) {
    super(message);
  }
}

type Stream = { slug: string; name: string; brief: string; status: string; created_at: string; updated_at: string };
type Item = {
  id: number; stream: string; title: string; body: string; kind: string; ball: string; priority: string;
  status: string; due: string | null; snooze_until: string | null; check_ref: string | null;
  check_state: string | null; checked_at: string | null; session_id: string | null; line: number | null;
  dedup_key: string | null; created_at: string; updated_at: string; closed_at: string | null; resolution: string | null;
};

export function openWork(): Database {
  mkdirSync(ccxDir(), { recursive: true });
  const db = new Database(join(ccxDir(), "work.db"), { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 3000");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`
    CREATE TABLE IF NOT EXISTS streams(
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      brief TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  db.run(`
    CREATE TABLE IF NOT EXISTS items(
      id INTEGER PRIMARY KEY,
      stream TEXT NOT NULL REFERENCES streams(slug) ON UPDATE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'do',
      ball TEXT NOT NULL DEFAULT 'me',
      priority TEXT NOT NULL DEFAULT 'med',
      status TEXT NOT NULL DEFAULT 'open',
      due TEXT,
      snooze_until TEXT,
      check_ref TEXT,
      check_state TEXT,
      checked_at TEXT,
      session_id TEXT,
      line INTEGER,
      dedup_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      resolution TEXT
    )`);
  db.run("CREATE INDEX IF NOT EXISTS idx_items_open ON items(status, stream)");
  // Summaries are dated rows, not one overwritten field: the newest is the stream's
  // current state and the rest are how it got there.
  db.run(`
    CREATE TABLE IF NOT EXISTS notes(
      id INTEGER PRIMARY KEY,
      stream TEXT NOT NULL REFERENCES streams(slug) ON UPDATE CASCADE,
      item_id INTEGER REFERENCES items(id),
      kind TEXT NOT NULL DEFAULT 'note',
      text TEXT NOT NULL,
      session_id TEXT,
      by TEXT NOT NULL,
      at TEXT NOT NULL
    )`);
  db.run("CREATE INDEX IF NOT EXISTS idx_notes_stream ON notes(stream, kind, at)");
  // One row per session once it's been read, with the transcript position it was read
  // through: a session that gets resumed later comes back to the inbox.
  db.run(`
    CREATE TABLE IF NOT EXISTS triaged(
      session_id TEXT PRIMARY KEY,
      through_ts TEXT NOT NULL,
      stream TEXT,
      at TEXT NOT NULL,
      by TEXT NOT NULL
    )`);
  db.run(`
    CREATE TABLE IF NOT EXISTS session_streams(
      session_id TEXT NOT NULL,
      stream TEXT NOT NULL REFERENCES streams(slug) ON UPDATE CASCADE,
      at TEXT NOT NULL,
      PRIMARY KEY(session_id, stream)
    )`);
  db.run(`
    CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY,
      item_id INTEGER,
      stream TEXT,
      at TEXT NOT NULL,
      by TEXT NOT NULL,
      event TEXT NOT NULL,
      detail TEXT
    )`);
  return db;
}

const now = () => new Date().toISOString();
const defaultSession = () => process.env.CLAUDE_CODE_SESSION_ID || null;
const defaultBy = () => {
  const sid = defaultSession();
  return sid ? `agent:${sid.slice(0, 8)}` : "me";
};

// ------------------------------------------------------------------ guards

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS key"],
  [/\bsk[0-9a-z]?[-_][A-Za-z0-9_-]{16,}/, "an API key"],
  [/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bAIza[0-9A-Za-z_-]{30,}/, "a Google key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/(?:password|passwd|passcode|secret|token)\b["'*`]*\s*(?:is|:|=)\s*["'*`]*[^\s"'*`]{8,}/i, "a password or token"],
];

/** Transcripts hold pasted credentials, and this file gets read by agents and shown in a browser. */
export function findSecret(text: string): string | null {
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return what;
  return null;
}

export function redact(text: string): string {
  let out = text;
  for (const [re] of SECRET_PATTERNS) out = out.replace(new RegExp(re.source, re.flags + "g"), "[redacted]");
  return out;
}

function rejectSecrets(...texts: (string | undefined | null)[]) {
  for (const t of texts) {
    const what = t ? findSecret(t) : null;
    if (what) throw new WorkError(`that text looks like it contains ${what}. Say where the credential is kept instead of what it is.`);
  }
}

const STOP = new Set("a an and are as at be but by for from has have in is it its of on or that the this to was will with".split(" "));
const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9#.]+/g, " ").split(" ").filter((w) => w && !STOP.has(w)));

/** Overlap of two titles, 0 to 1. */
export function similarity(a: string, b: string): number {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  return shared / (ta.size + tb.size - shared);
}

function oneOf<T extends string>(v: string | undefined, allowed: readonly T[], label: string): T | undefined {
  if (v === undefined) return undefined;
  if (!allowed.includes(v as T)) throw new WorkError(`${label} must be one of: ${allowed.join(", ")}`);
  return v as T;
}

function checkRef(v: string | undefined): string | undefined {
  if (v === undefined || v === "") return undefined;
  if (!parseCheck(v)) throw new WorkError(`--check must look like pr:owner/repo#123 or issue:owner/repo#123`);
  return v;
}

/** Only structured checks, never a stored shell command: agents write these rows and a schedule runs them. */
export function parseCheck(ref: string): { type: "pr" | "issue"; repo: string; number: number } | null {
  const m = ref.match(/^(pr|issue):([\w.-]+\/[\w.-]+)#(\d+)$/);
  return m ? { type: m[1] as "pr" | "issue", repo: m[2]!, number: Number(m[3]) } : null;
}

/** "3d"/"2w" count forward here, unlike search's --since. */
function parseFuture(s: string): string {
  const m = s.match(/^(\d+)([hdw])$/);
  if (m) return new Date(Date.now() + Number(m[1]) * { h: 3600_000, d: DAY, w: 7 * DAY }[m[2] as "h" | "d" | "w"]).toISOString();
  return parseWhen(s);
}

function dateOnly(s: string): string {
  return parseFuture(s).slice(0, 10);
}

// ------------------------------------------------------------------ core

function logEvent(db: Database, by: string, event: string, o: { item?: number; stream?: string; detail?: string } = {}) {
  db.prepare("INSERT INTO events(item_id, stream, at, by, event, detail) VALUES (?,?,?,?,?,?)")
    .run(o.item ?? null, o.stream ?? null, now(), by, event, o.detail ?? null);
}

function getStream(db: Database, slug: string): Stream {
  const s = db.prepare<Stream, [string]>("SELECT * FROM streams WHERE slug = ?").get(slug);
  if (s) return s;
  const known = db.prepare<{ slug: string }, []>("SELECT slug FROM streams ORDER BY slug").all().map((r) => r.slug);
  throw new WorkError(`no workstream "${slug}". Known: ${known.join(", ") || "none yet"}`);
}

function getItem(db: Database, id: string | number): Item {
  const n = Number(id);
  const it = Number.isInteger(n) ? db.prepare<Item, [number]>("SELECT * FROM items WHERE id = ?").get(n) : null;
  if (!it) throw new WorkError(`no item ${id}`);
  return it;
}

function linkSession(db: Database, session: string | null | undefined, stream: string) {
  if (session) db.prepare("INSERT OR IGNORE INTO session_streams(session_id, stream, at) VALUES (?,?,?)").run(session, stream, now());
}

/** Accepts a full id or a prefix, using the index to expand it. */
function resolveSession(session: string | null | undefined): string | null {
  if (!session) return null;
  if (session.length >= 36) return session;
  const idx = openDb();
  const hits = idx.prepare<{ session_id: string }, [string]>("SELECT session_id FROM sessions WHERE session_id LIKE ? LIMIT 2").all(`${session}%`);
  if (hits.length !== 1) throw new WorkError(hits.length ? `session prefix ${session} is ambiguous` : `no session matching ${session}`);
  return hits[0]!.session_id;
}

export function addItem(db: Database, input: {
  stream: string; title: string; body?: string; kind?: string; ball?: string; priority?: string; due?: string;
  check?: string; session?: string | null; line?: number; key?: string; force?: boolean; by: string;
}): { item: Item; existed: boolean } {
  getStream(db, input.stream);
  const title = oneLine(input.title);
  if (!title) throw new WorkError("an item needs a title");
  rejectSecrets(title, input.body);
  if (input.key) {
    const same = db.prepare<Item, [string]>("SELECT * FROM items WHERE dedup_key = ?").get(input.key);
    if (same) return { item: same, existed: true };
  }
  if (!input.force) {
    const open = db.prepare<Item, [string]>("SELECT * FROM items WHERE stream = ? AND status = 'open'").all(input.stream);
    const twin = open.map((i) => ({ i, score: similarity(i.title, title) })).sort((a, b) => b.score - a.score)[0];
    if (twin && twin.score >= 0.6) {
      throw new WorkError(`looks like open item #${twin.i.id}: "${twin.i.title}". Update that one, or pass --force if they differ.`, 3, { duplicate_of: twin.i.id });
    }
  }
  const at = now();
  const r = db.prepare(`
    INSERT INTO items(stream, title, body, kind, ball, priority, due, check_ref, session_id, line, dedup_key, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.stream, title, input.body ?? "", input.kind ?? "do", input.ball || "me", input.priority ?? "med",
    input.due ?? null, input.check ?? null, input.session ?? null, input.line ?? null, input.key ?? null, at, at,
  );
  const id = Number(r.lastInsertRowid);
  linkSession(db, input.session, input.stream);
  logEvent(db, input.by, "add", { item: id, stream: input.stream, detail: title });
  return { item: getItem(db, id), existed: false };
}

function closeItem(db: Database, id: string | number, status: "done" | "dropped", note: string | undefined, by: string): Item {
  const it = getItem(db, id);
  rejectSecrets(note);
  if (it.status !== "open") return it;
  const at = now();
  db.prepare("UPDATE items SET status = ?, resolution = ?, closed_at = ?, updated_at = ? WHERE id = ?").run(status, note ?? null, at, at, it.id);
  logEvent(db, by, status, { item: it.id, stream: it.stream, detail: note });
  return getItem(db, it.id);
}

/** The index is optional here: the tracker still works if it hasn't been built. */
function sessionInfo(ids: string[]): Map<string, { title: string | null; cwd: string | null; last_ts: string | null; project: string }> {
  const out = new Map();
  if (!ids.length) return out;
  try {
    const idx = openDb();
    const q = idx.prepare<{ session_id: string; title: string | null; cwd: string | null; last_ts: string | null; project: string }, [string]>(
      "SELECT session_id, title, cwd, last_ts, project FROM sessions WHERE session_id = ?");
    for (const id of new Set(ids)) {
      const r = q.get(id);
      if (r) out.set(id, { title: r.title, cwd: r.cwd, last_ts: r.last_ts, project: projectLabel(r.project, r.cwd) });
    }
  } catch { /* no index yet */ }
  return out;
}

const PRIORITY_RANK: Record<string, number> = { high: 0, med: 1, low: 2 };

function presentItem(it: Item, sessions: ReturnType<typeof sessionInfo>) {
  const t = Date.now();
  const days = (iso: string) => Math.floor((t - new Date(iso).getTime()) / DAY);
  const session = it.session_id ? sessions.get(it.session_id) : undefined;
  const dueIn = it.due ? Math.ceil((new Date(it.due + "T23:59:59").getTime() - t) / DAY) : null;
  return {
    ...it,
    holder: it.ball === "me" ? "me" : it.ball === "agent" ? "agent" : "them",
    age_days: days(it.created_at),
    idle_days: days(it.updated_at),
    stale: it.status === "open" && days(it.updated_at) >= STALE_DAYS,
    due_in_days: dueIn,
    overdue: dueIn !== null && dueIn < 0 && it.status === "open",
    snoozed: Boolean(it.snooze_until && new Date(it.snooze_until).getTime() > t),
    session: it.session_id ? {
      id: it.session_id,
      title: session?.title ?? null,
      cwd: session?.cwd ?? null,
      project: session?.project ?? null,
      last_ts: session?.last_ts ?? null,
      show: `ccx show ${it.session_id.slice(0, 8)}${it.line ? ` --line ${it.line}` : ""}`,
      resume: session?.cwd ? `cd ${session.cwd} && claude -r ${it.session_id}` : `claude -r ${it.session_id}`,
    } : null,
  };
}
export type PresentedItem = ReturnType<typeof presentItem>;

/** What needs a look soonest: due first, then priority, then what's on you. */
function urgency(a: PresentedItem, b: PresentedItem): number {
  const dueRank = (i: PresentedItem) => (i.due_in_days === null ? 9999 : i.due_in_days);
  const hold = (i: PresentedItem) => (i.holder === "me" ? 0 : i.holder === "agent" ? 1 : 2);
  return (Math.min(dueRank(a), 14) - Math.min(dueRank(b), 14))
    || (PRIORITY_RANK[a.priority]! - PRIORITY_RANK[b.priority]!)
    || (hold(a) - hold(b))
    || (a.created_at < b.created_at ? -1 : 1);
}

export function board(db: Database, opts: { stream?: string; on?: string; kind?: string; all?: boolean; closed?: boolean } = {}) {
  const streams = opts.stream
    ? [getStream(db, opts.stream)]
    : db.prepare<Stream, []>("SELECT * FROM streams WHERE status = 'active' OR ? ORDER BY name".replace("?", opts.all ? "1" : "0")).all();
  const rows = db.prepare<Item, []>(`SELECT * FROM items WHERE status = 'open'${opts.closed ? " OR closed_at >= '" + new Date(Date.now() - 14 * DAY).toISOString() + "'" : ""}`).all();
  const linked = db.prepare<{ session_id: string; stream: string }, []>("SELECT session_id, stream FROM session_streams").all();
  const info = sessionInfo([...rows.map((r) => r.session_id).filter(Boolean) as string[], ...linked.map((l) => l.session_id)]);
  const items = rows.map((r) => presentItem(r, info));
  const summaryOf = db.prepare<{ text: string; at: string; by: string }, [string]>(
    "SELECT text, at, by FROM notes WHERE stream = ? AND kind = 'summary' ORDER BY at DESC, id DESC LIMIT 1");

  const groups = streams.map((s) => {
    const mine = items.filter((i) => i.stream === s.slug);
    const open = mine.filter((i) => i.status === "open");
    const live = open.filter((i) => !i.snoozed);
    const shown = (opts.all ? mine : mine.filter((i) => i.status !== "open" || !i.snoozed))
      .filter((i) => !opts.on || i.ball === opts.on || i.holder === opts.on)
      .filter((i) => !opts.kind || i.kind === opts.kind)
      .sort(urgency);
    const sess = linked.filter((l) => l.stream === s.slug).map((l) => ({ id: l.session_id, ...info.get(l.session_id) }))
      .filter((x) => x.last_ts).sort((a, b) => (a.last_ts! > b.last_ts! ? -1 : 1));
    return {
      ...s,
      summary: summaryOf.get(s.slug) ?? null,
      counts: {
        open: open.length,
        me: live.filter((i) => i.holder === "me").length,
        agent: live.filter((i) => i.holder === "agent").length,
        them: live.filter((i) => i.holder === "them").length,
        snoozed: open.length - live.length,
        stale: live.filter((i) => i.stale).length,
      },
      last_activity: sess[0]?.last_ts ?? s.updated_at,
      sessions: sess.slice(0, 5),
      items: shown,
    };
  });

  // Streams with the most waiting on you lead; a stream with nothing open sinks.
  const heat = (g: (typeof groups)[number]) =>
    g.items.filter((i) => i.status === "open" && i.holder === "me" && (i.priority === "high" || (i.due_in_days ?? 99) <= 3)).length * 3 + g.counts.me;
  groups.sort((a, b) => heat(b) - heat(a) || (a.last_activity < b.last_activity ? 1 : -1));

  const live = items.filter((i) => i.status === "open" && !i.snoozed);
  return {
    generated: now(),
    totals: {
      open: live.length,
      me: live.filter((i) => i.holder === "me").length,
      agent: live.filter((i) => i.holder === "agent").length,
      them: live.filter((i) => i.holder === "them").length,
      stale: live.filter((i) => i.stale).length,
      overdue: live.filter((i) => i.overdue).length,
    },
    streams: groups,
  };
}

export function inbox(db: Database, opts: { since?: string; limit?: number; min?: number } = {}) {
  const idx = openDb();
  runIndex(idx, { quiet: true });
  const since = parseWhen(opts.since ?? "14d");
  const settled = new Date(Date.now() - SETTLE_MINUTES * 60_000).toISOString();
  const rows = idx.prepare<{ session_id: string; project: string; cwd: string | null; title: string | null; last_ts: string; entry_count: number }, [string, string, number]>(`
    SELECT session_id, project, cwd, title, last_ts, entry_count FROM sessions
    WHERE last_ts >= ? AND last_ts <= ? AND entry_count >= ? AND (cwd IS NULL OR cwd NOT LIKE '/private/tmp/%')
    ORDER BY last_ts DESC`).all(since, settled, opts.min ?? 40);
  const seen = db.prepare<{ through_ts: string }, [string]>("SELECT through_ts FROM triaged WHERE session_id = ?");
  const tail = idx.prepare<{ text: string }, [string]>(
    "SELECT text FROM fts WHERE session_id = ? AND kind = 'assistant' AND side = 0 ORDER BY ts DESC LIMIT 1");
  const pending = rows.filter((r) => {
    const s = seen.get(r.session_id);
    return !s || s.through_ts < r.last_ts;
  });
  return {
    pending: pending.length,
    sessions: pending.slice(0, opts.limit ?? 25).map((r) => ({
      session: r.session_id,
      title: r.title,
      project: projectLabel(r.project, r.cwd),
      cwd: r.cwd,
      last_ts: r.last_ts,
      entries: r.entry_count,
      revisit: Boolean(seen.get(r.session_id)),
      ending: redact((tail.get(r.session_id)?.text ?? "").slice(-1600)),
      read_more: `ccx show ${r.session_id.slice(0, 8)} --tail 20`,
    })),
  };
}

export function markTriaged(db: Database, sessions: string[], stream: string | undefined, by: string) {
  const idx = openDb();
  const lastOf = idx.prepare<{ last_ts: string }, [string]>("SELECT last_ts FROM sessions WHERE session_id = ?");
  for (const raw of sessions) {
    const id = resolveSession(raw)!;
    db.prepare("INSERT OR REPLACE INTO triaged(session_id, through_ts, stream, at, by) VALUES (?,?,?,?,?)")
      .run(id, lastOf.get(id)?.last_ts ?? now(), stream ?? null, now(), by);
    if (stream) linkSession(db, id, stream);
  }
}

/** Services started by launchd or systemd often have neither Homebrew nor ~/.local on PATH. */
function findGh(): string {
  const gh = Bun.which("gh") ?? ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"].find(existsSync);
  if (!gh) throw new WorkError("checks need the GitHub CLI (gh), and it isn't installed");
  return gh;
}

/** Ask GitHub about every open item with a check. Finished work closes itself. */
export async function runChecks(db: Database, by = "check") {
  const items = db.prepare<Item, []>("SELECT * FROM items WHERE status = 'open' AND check_ref IS NOT NULL").all();
  if (!items.length) return { checked: 0, closed: 0, results: [] };
  const gh = findGh();
  const results: { id: number; title: string; check: string; state: string; closed: boolean }[] = [];
  const queue = [...items];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      const c = parseCheck(it.check_ref!);
      if (!c) continue;
      const proc = Bun.spawn([gh, c.type, "view", String(c.number), "-R", c.repo, "--json", "state"], { stdout: "pipe", stderr: "pipe" });
      const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      let state = "UNKNOWN";
      if (code === 0) try { state = JSON.parse(text).state ?? "UNKNOWN"; } catch { /* stays unknown */ }
      const at = now();
      db.prepare("UPDATE items SET check_state = ?, checked_at = ? WHERE id = ?").run(state, at, it.id);
      const finished = state === "MERGED" || state === "CLOSED";
      if (finished) closeItem(db, it.id, "done", `${it.check_ref} is ${state.toLowerCase()}`, by);
      results.push({ id: it.id, title: it.title, check: it.check_ref!, state, closed: finished });
    }
  }));
  return { checked: results.length, closed: results.filter((r) => r.closed).length, results };
}

// ------------------------------------------------------------------ text output

const HOLD_MARK: Record<string, (s: string) => string> = { me: yellow, agent: cyan, them: magenta };

function itemLine(i: PresentedItem): string {
  const who = HOLD_MARK[i.holder]!(i.ball.padEnd(8));
  const flags = [
    i.priority === "high" ? red("high") : "",
    i.kind !== "do" ? i.kind : "",
    i.overdue ? red(`overdue ${i.due}`) : i.due ? `due ${i.due}` : "",
    i.check_state ? `${i.check_ref} ${i.check_state.toLowerCase()}` : "",
    i.stale ? dim(`idle ${i.idle_days}d`) : "",
    i.snoozed ? dim("snoozed") : "",
  ].filter(Boolean).join(dim(", "));
  return `  ${dim(String(i.id).padStart(3))}  ${who} ${i.title}${flags ? `  ${dim("(")}${flags}${dim(")")}` : ""}`;
}

function printBoard(b: ReturnType<typeof board>) {
  const t = b.totals;
  printOut(`${bold(`${t.open} open`)}  ${yellow(`${t.me} on you`)}  ${cyan(`${t.agent} an agent can take`)}  ${magenta(`${t.them} waiting on others`)}` +
    (t.overdue ? `  ${red(`${t.overdue} overdue`)}` : "") + (t.stale ? `  ${dim(`${t.stale} idle ${STALE_DAYS}d+`)}` : "") + "\n");
  for (const s of b.streams) {
    if (!s.items.length) continue;
    printOut(`${bold(s.name)} ${dim(s.slug)}`);
    if (s.summary) printOut(`  ${dim(s.summary.text)}`);
    printOut(s.items.map(itemLine).join("\n") + "\n");
  }
}

// ------------------------------------------------------------------ command line

export const WORK_HELP = `${bold("ccx work")} — open items grouped by workstream

  ccx work [stream] [--on me|agent|<name>] [--kind k] [--all] [--json]    the board
  ccx work streams [--json]                                               list workstreams
  ccx work stream <slug> [--name n] [--brief b] [--status s]              create or update one
  ccx work summary <stream> <text>                                        set where it stands now

  ccx work add <stream> <title> [--kind do|decide|verify|risk] [--on who] [--priority high|med|low]
                                [--due date] [--body b] [--check pr:o/r#1] [--session id] [--line n] [--key k] [--force]
  ccx work show <id>                  one item with its history
  ccx work edit <id> [--title t] [--stream s] [--on who] [--kind k] [--priority p] [--due d] [--body b] [--check c]
  ccx work done <id> [--note n]       finished
  ccx work drop <id> [--note n]       no longer worth doing
  ccx work reopen <id>
  ccx work snooze <id> <3d|2w|date>   hide until then
  ccx work note <id|stream> <text>    add context

  ccx work inbox [--since 14d] [-n 25] [--json]   sessions nobody has read for open items yet
  ccx work triaged <session>... [--stream s]      mark them read
  ccx work link <session> <stream>                attach a session to a workstream
  ccx work check [--json]                         ask GitHub about items with a --check; closes finished ones
  ccx work log [-n 30] [--json]                   what changed recently
  ccx work guide                                  how an agent should use this

Data lives in ~/.ccx/work.db, separate from the search index.
`;

export const WORK_GUIDE = `# Keeping the work tracker

\`ccx work\` holds what's still open, grouped by workstream. It's how the next session and the
person you work for find out what happened in this one. Add to it when something is left open;
don't add a record of what's finished.

## During any session

Before ending, ask what's still open from this session. For each thing:

    ccx work add <stream> "<one line a stranger could act on>" --on <who> --kind <kind>

- **--on**: who holds the ball. \`me\` is the person you work for: they must decide, approve, or do it.
  \`agent\` means an agent could finish it with no further input. A person's name means it's
  waiting on them. Choose the one who can move it next, not who cares about it.
- **--kind**: \`do\`, \`decide\` (a question only a person can answer; write it as the question),
  \`verify\` (shipped but not seen working), \`risk\` (a hazard someone could walk into).
- **--check pr:owner/repo#123** when an open PR or issue finishing it means the item is finished.
- **--due** only for a real date, like an expiry or a promised deadline.
- **--priority high** only if something is blocked or at risk without it.

The current session is recorded automatically. Close what you finished: \`ccx work done <id> --note "..."\`.
Update the stream when its state changed: \`ccx work summary <stream> "<where it stands, in a line or two>"\`.

Leave out offers ("want me to...?") unless the person would miss them, and leave out anything the
session itself resolved. Never put a credential in an item, not even a temporary one: say where it's kept.

## Triage (a pass over sessions nobody read)

1. \`ccx work streams\` and \`ccx work --json\`, so you know what exists and what's already tracked.
2. \`ccx work inbox --json\`. Each session has its ending; \`read_more\` shows more when the ending isn't enough.
3. Sort by content, not folder: one folder can hold several workstreams, and titles often describe only
   how a session began. A session can feed several streams.
4. For each open thing, update the item that already exists if there is one. Otherwise add it with
   \`--session <id>\`. If add refuses a duplicate, read the item it names before forcing.
5. When a finished thing matches an open item, close it with a note saying how you know.
6. \`ccx work triaged <session> --stream <slug>\` for every session you read, including those with nothing open.
7. \`ccx work check\` last, so anything GitHub says is finished closes.

Create a stream only for a line of work that'll outlast this week. Prefer an existing one.
`;

const ITEM_OPTIONS = {
  kind: { type: "string" }, on: { type: "string" }, priority: { type: "string" }, due: { type: "string" },
  body: { type: "string" }, check: { type: "string" }, session: { type: "string" }, line: { type: "string" },
  key: { type: "string" }, force: { type: "boolean", default: false }, json: { type: "boolean", default: false },
  by: { type: "string" }, title: { type: "string" }, stream: { type: "string" },
} as const;

function emit(json: boolean, value: unknown, text: string) {
  printOut(json ? JSON.stringify(value, null, 2) : text);
}

export async function runWork(args: string[]) {
  const sub = args[0];
  const VERBS = new Set(["streams", "stream", "summary", "add", "show", "edit", "done", "drop", "reopen", "snooze", "note", "inbox", "triaged", "link", "check", "log", "guide", "help"]);
  if (sub === "help" || sub === "--help" || sub === "-h") return printOut(WORK_HELP);
  if (sub === "guide") return printOut(WORK_GUIDE);
  const db = openWork();

  // `ccx work`, `ccx work --json`, `ccx work <stream>`
  if (!sub || sub.startsWith("-") || !VERBS.has(sub)) {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true,
      options: { on: { type: "string" }, kind: { type: "string" }, all: { type: "boolean", default: false }, closed: { type: "boolean", default: false }, json: { type: "boolean", default: false } },
    });
    const b = board(db, { stream: positionals[0], on: values.on, kind: values.kind, all: values.all, closed: values.closed });
    if (values.json) return printOut(JSON.stringify(b, null, 2));
    if (!b.streams.length) return printOut(dim('No workstreams yet. Start with: ccx work stream my-project --name "My project"'));
    return printBoard(b);
  }

  const rest = args.slice(1);
  switch (sub) {
    case "streams": {
      const { values } = parseArgs({ args: rest, options: { json: { type: "boolean", default: false }, all: { type: "boolean", default: false } } });
      const b = board(db, { all: values.all });
      const rows = b.streams.map(({ items, ...s }) => s);
      return emit(values.json, { streams: rows }, rows.map((s) =>
        `${bold(s.slug.padEnd(16))} ${String(s.counts.open).padStart(3)} open  ${dim(s.brief || s.name)}`).join("\n"));
    }

    case "stream": {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true,
        options: { name: { type: "string" }, brief: { type: "string" }, status: { type: "string" }, slug: { type: "string" }, json: { type: "boolean", default: false }, by: { type: "string" } },
      });
      const slug = positionals[0];
      if (!slug) throw new WorkError("stream needs a slug");
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new WorkError("a stream slug is lowercase words joined by dashes");
      const status = oneOf(values.status, STREAM_STATUSES, "--status");
      rejectSecrets(values.name, values.brief);
      const at = now();
      const by = values.by ?? defaultBy();
      const existing = db.prepare<Stream, [string]>("SELECT * FROM streams WHERE slug = ?").get(slug);
      if (existing) {
        db.prepare("UPDATE streams SET name = ?, brief = ?, status = ?, updated_at = ? WHERE slug = ?")
          .run(values.name ?? existing.name, values.brief ?? existing.brief, status ?? existing.status, at, slug);
        if (values.slug) db.prepare("UPDATE streams SET slug = ? WHERE slug = ?").run(values.slug, slug);
        logEvent(db, by, "stream-edit", { stream: values.slug ?? slug });
      } else {
        db.prepare("INSERT INTO streams(slug, name, brief, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
          .run(slug, values.name ?? slug, values.brief ?? "", status ?? "active", at, at);
        logEvent(db, by, "stream-add", { stream: slug });
      }
      const s = getStream(db, values.slug ?? slug);
      return emit(values.json, s, `${existing ? "Updated" : "Created"} ${bold(s.slug)}`);
    }

    case "summary":
    case "note": {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true,
        options: { session: { type: "string" }, json: { type: "boolean", default: false }, by: { type: "string" } },
      });
      const [target, ...words] = positionals;
      const text = words.join(" ").trim();
      if (!target || !text) throw new WorkError(`${sub} needs a target and some text`);
      rejectSecrets(text);
      const item = /^\d+$/.test(target) ? getItem(db, target) : null;
      if (sub === "summary" && item) throw new WorkError("a summary belongs to a stream, not an item");
      const stream = item?.stream ?? getStream(db, target).slug;
      const session = resolveSession(values.session) ?? defaultSession();
      const by = values.by ?? defaultBy();
      db.prepare("INSERT INTO notes(stream, item_id, kind, text, session_id, by, at) VALUES (?,?,?,?,?,?,?)")
        .run(stream, item?.id ?? null, sub, text, session, by, now());
      if (item) db.prepare("UPDATE items SET updated_at = ? WHERE id = ?").run(now(), item.id);
      linkSession(db, session, stream);
      logEvent(db, by, sub, { item: item?.id, stream, detail: text.slice(0, 200) });
      return emit(values.json, { ok: true, stream, item: item?.id ?? null }, `Saved ${sub} on ${item ? `#${item.id}` : stream}`);
    }

    case "add": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: ITEM_OPTIONS });
      const [stream, ...words] = positionals;
      if (!stream || !words.length) throw new WorkError('add needs a stream and a title: ccx work add my-stream "what is open"');
      const { item, existed } = addItem(db, {
        stream, title: words.join(" "), body: values.body,
        kind: oneOf(values.kind, KINDS, "--kind"),
        ball: values.on,
        priority: oneOf(values.priority, PRIORITIES, "--priority"),
        due: values.due ? dateOnly(values.due) : undefined,
        check: checkRef(values.check),
        session: resolveSession(values.session) ?? defaultSession(),
        line: values.line ? Number(values.line) : undefined,
        key: values.key, force: values.force,
        by: values.by ?? defaultBy(),
      });
      return emit(values.json, { item, existed }, `${existed ? "Already tracked" : "Added"} ${bold(`#${item.id}`)} in ${item.stream}`);
    }

    case "show": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: "boolean", default: false } } });
      const it = getItem(db, positionals[0] ?? "");
      const p = presentItem(it, sessionInfo(it.session_id ? [it.session_id] : []));
      const notes = db.prepare<{ text: string; by: string; at: string }, [number]>("SELECT text, by, at FROM notes WHERE item_id = ? ORDER BY at").all(it.id);
      const events = db.prepare<{ at: string; by: string; event: string; detail: string | null }, [number]>("SELECT at, by, event, detail FROM events WHERE item_id = ? ORDER BY id").all(it.id);
      const text = [
        `${bold(`#${p.id}`)} ${p.title}`,
        dim(`${p.stream}, ${p.status}, ${p.kind}, on ${p.ball}, ${p.priority}${p.due ? `, due ${p.due}` : ""}`),
        p.body,
        p.session ? `${dim("from")} ${p.session.title ?? p.session.id}\n  ${p.session.show}\n  ${p.session.resume}` : "",
        p.check_ref ? `${dim("check")} ${p.check_ref} ${p.check_state ?? "not run yet"}` : "",
        ...notes.map((n) => `${dim(n.at.slice(0, 10))} ${n.text}`),
        p.resolution ? `${green(p.status)} ${p.resolution}` : "",
      ].filter(Boolean).join("\n");
      return emit(values.json, { item: p, notes, events }, text);
    }

    case "edit": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: ITEM_OPTIONS });
      const it = getItem(db, positionals[0] ?? "");
      if (values.stream) getStream(db, values.stream);
      rejectSecrets(values.title, values.body);
      const next = {
        title: values.title !== undefined ? oneLine(values.title) : it.title,
        body: values.body ?? it.body,
        stream: values.stream ?? it.stream,
        kind: oneOf(values.kind, KINDS, "--kind") ?? it.kind,
        ball: values.on ?? it.ball,
        priority: oneOf(values.priority, PRIORITIES, "--priority") ?? it.priority,
        due: values.due !== undefined ? (values.due ? dateOnly(values.due) : null) : it.due,
        check_ref: values.check !== undefined ? (checkRef(values.check) ?? null) : it.check_ref,
      };
      db.prepare("UPDATE items SET title = ?, body = ?, stream = ?, kind = ?, ball = ?, priority = ?, due = ?, check_ref = ?, updated_at = ? WHERE id = ?")
        .run(next.title, next.body, next.stream, next.kind, next.ball, next.priority, next.due, next.check_ref, now(), it.id);
      logEvent(db, values.by ?? defaultBy(), "edit", { item: it.id, stream: next.stream, detail: Object.keys(values).filter((k) => k !== "by" && k !== "json" && k !== "force").join(",") });
      return emit(values.json, getItem(db, it.id), `Updated ${bold(`#${it.id}`)}`);
    }

    case "done":
    case "drop": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { note: { type: "string" }, json: { type: "boolean", default: false }, by: { type: "string" } } });
      const it = closeItem(db, positionals[0] ?? "", sub === "done" ? "done" : "dropped", values.note, values.by ?? defaultBy());
      return emit(values.json, it, `${sub === "done" ? "Finished" : "Dropped"} ${bold(`#${it.id}`)}`);
    }

    case "reopen": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: "boolean", default: false }, by: { type: "string" } } });
      const it = getItem(db, positionals[0] ?? "");
      db.prepare("UPDATE items SET status = 'open', closed_at = NULL, resolution = NULL, updated_at = ? WHERE id = ?").run(now(), it.id);
      logEvent(db, values.by ?? defaultBy(), "reopen", { item: it.id, stream: it.stream });
      return emit(values.json, getItem(db, it.id), `Reopened ${bold(`#${it.id}`)}`);
    }

    case "snooze": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: "boolean", default: false }, by: { type: "string" } } });
      const it = getItem(db, positionals[0] ?? "");
      if (!positionals[1]) throw new WorkError("snooze needs a time: 3d, 2w, or a date");
      const until = parseFuture(positionals[1]);
      db.prepare("UPDATE items SET snooze_until = ?, updated_at = ? WHERE id = ?").run(until, now(), it.id);
      logEvent(db, values.by ?? defaultBy(), "snooze", { item: it.id, stream: it.stream, detail: until });
      return emit(values.json, getItem(db, it.id), `Snoozed ${bold(`#${it.id}`)} until ${until.slice(0, 10)}`);
    }

    case "inbox": {
      const { values } = parseArgs({
        args: rest,
        options: { since: { type: "string", short: "s" }, limit: { type: "string", short: "n" }, min: { type: "string" }, json: { type: "boolean", default: false } },
      });
      const r = inbox(db, { since: values.since, limit: values.limit ? Number(values.limit) : undefined, min: values.min ? Number(values.min) : undefined });
      return emit(values.json, r, [`${bold(`${r.pending} sessions to read`)}`, ...r.sessions.map((s) =>
        `  ${dim(s.session.slice(0, 8))}  ${s.last_ts.slice(0, 10)}  ${s.title ?? "(untitled)"} ${dim(s.project)}`)].join("\n"));
    }

    case "triaged": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { stream: { type: "string" }, json: { type: "boolean", default: false }, by: { type: "string" } } });
      if (!positionals.length) throw new WorkError("triaged needs at least one session");
      if (values.stream) getStream(db, values.stream);
      markTriaged(db, positionals, values.stream, values.by ?? defaultBy());
      return emit(values.json, { ok: true, count: positionals.length }, `Marked ${positionals.length} read`);
    }

    case "link": {
      const [session, stream] = rest;
      if (!session || !stream) throw new WorkError("link needs a session and a stream");
      getStream(db, stream);
      linkSession(db, resolveSession(session), stream);
      return printOut(`Linked to ${stream}`);
    }

    case "check": {
      const { values } = parseArgs({ args: rest, options: { json: { type: "boolean", default: false } } });
      const r = await runChecks(db);
      return emit(values.json, r, [`Checked ${r.checked}, closed ${r.closed}`, ...r.results.filter((x) => x.closed).map((x) => `  ${green("closed")} #${x.id} ${x.title} ${dim(x.check)}`)].join("\n"));
    }

    case "log": {
      const { values } = parseArgs({ args: rest, options: { limit: { type: "string", short: "n", default: "30" }, json: { type: "boolean", default: false } } });
      const rows = db.prepare<{ at: string; by: string; event: string; stream: string | null; item_id: number | null; detail: string | null }, [number]>(
        "SELECT at, by, event, stream, item_id, detail FROM events ORDER BY id DESC LIMIT ?").all(Number(values.limit) || 30);
      return emit(values.json, { events: rows }, rows.map((e) =>
        `${dim(e.at.slice(0, 16).replace("T", " "))} ${e.event.padEnd(8)} ${e.item_id ? `#${e.item_id} ` : ""}${dim(e.stream ?? "")} ${e.detail ?? ""}`).join("\n"));
    }
  }
}
