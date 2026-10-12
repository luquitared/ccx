import type { Database } from "bun:sqlite";
import { basename, dirname } from "node:path";
import type { SessionRow } from "./db.ts";
import {
  bold,
  cyan,
  dim,
  fmtDate,
  green,
  oneLine,
  projectLabel,
  yellow,
} from "./util.ts";

export type SearchOpts = {
  project?: string;
  since?: string; // ISO
  until?: string; // ISO
  kind?: string;
  tool?: string;
  session?: string;
  mainOnly?: boolean;
  raw?: boolean;
  limit: number;
};

export type Hit = {
  key: string;
  uuid: string | null;
  kind: string;
  tool: string | null;
  session_id: string;
  project: string;
  ts: string | null;
  file: string;
  line: number;
  side: number;
  snip: string;
  rank: number;
};

const MARK_L = "⟦"; // ⟦
const MARK_R = "⟧"; // ⟧

export function ftsQuery(q: string, raw: boolean): string {
  if (raw) return q;
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replaceAll('"', '""')}"`)
    .join(" ");
}

export function search(db: Database, query: string, opts: SearchOpts): Hit[] {
  const params: (string | number)[] = [ftsQuery(query, opts.raw ?? false)];
  let sql = `
    SELECT key, uuid, kind, tool, session_id, project, ts, file,
           CAST(line AS INTEGER) AS line, CAST(side AS INTEGER) AS side,
           snippet(fts, 0, '${MARK_L}', '${MARK_R}', ' … ', 24) AS snip,
           bm25(fts) AS rank
    FROM fts WHERE fts MATCH ?`;
  if (opts.project) {
    sql += " AND project LIKE ?";
    params.push(`%${opts.project}%`);
  }
  if (opts.since) {
    sql += " AND ts >= ?";
    params.push(opts.since);
  }
  if (opts.until) {
    sql += " AND ts <= ?";
    params.push(opts.until);
  }
  if (opts.kind) {
    sql += " AND kind = ?";
    params.push(opts.kind);
  }
  if (opts.tool) {
    sql += " AND kind = 'tool_use' AND tool = ?";
    params.push(opts.tool);
  }
  if (opts.session) {
    sql += " AND session_id LIKE ? || '%'";
    params.push(opts.session);
  }
  if (opts.mainOnly) {
    sql += " AND side = 0";
  }
  sql += " ORDER BY rank LIMIT ?";
  params.push(opts.limit);

  return db.prepare<Hit, (string | number)[]>(sql).all(...params);
}

export function sessionMap(db: Database, hits: Hit[]): Map<string, SessionRow> {
  const map = new Map<string, SessionRow>();
  const get = db.prepare<SessionRow, [string]>(
    "SELECT * FROM sessions WHERE session_id = ?",
  );
  for (const h of hits) {
    if (map.has(h.session_id)) continue;
    const row = get.get(h.session_id);
    if (row) map.set(h.session_id, row);
  }
  return map;
}

export function printHits(db: Database, hits: Hit[], asJson: boolean) {
  const sessions = sessionMap(db, hits);
  if (asJson) {
    const results = hits.map((h) => ({
      session: h.session_id,
      project: projectLabel(h.project, sessions.get(h.session_id)?.cwd),
      title: sessions.get(h.session_id)?.title ?? null,
      kind: h.kind,
      tool: h.tool,
      timestamp: h.ts,
      file: h.file,
      line: h.line,
      sidechain: h.side === 1,
      snippet: h.snip.replaceAll(MARK_L, "").replaceAll(MARK_R, ""),
      show: showCommand(h),
    }));
    console.log(JSON.stringify({ results }, null, 2));
    return;
  }
  if (hits.length === 0) {
    console.log(dim("No results."));
    return;
  }
  hits.forEach((h, i) => {
    const s = sessions.get(h.session_id);
    const proj = projectLabel(h.project, s?.cwd);
    const kind = h.tool ? `${h.kind}(${h.tool})` : h.kind;
    const title = s?.title ?? oneLine(s?.first_prompt ?? "").slice(0, 60);
    const tty = process.stdout.isTTY && !process.env.NO_COLOR;
    const snippet = oneLine(h.snip)
      .replaceAll(MARK_L, tty ? "\x1b[1;33m" : "")
      .replaceAll(MARK_R, tty ? "\x1b[0m" : "");
    console.log(
      `${dim(String(i + 1).padStart(2))}. ${cyan(proj)} · ${fmtDate(h.ts)} · ${yellow(kind)}${h.side ? dim(" · agent") : ""} ${title ? dim("· " + title) : ""}`,
    );
    console.log(`    ${snippet.slice(0, 400)}`);
    console.log(`    ${green("↳")} ${dim(showCommand(h))}`);
  });
}

function showCommand(h: Hit): string {
  const stem = basename(h.file, ".jsonl");
  const isMainFile = stem === h.session_id && !dirname(h.file).endsWith(h.session_id);
  const target = isMainFile ? h.session_id.slice(0, 8) : h.file;
  return `ccx show ${target} --line ${h.line}`;
}
