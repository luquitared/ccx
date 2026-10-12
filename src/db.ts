import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ccxDir } from "./util.ts";

export function openDb(): Database {
  mkdirSync(ccxDir(), { recursive: true });
  const db = new Database(join(ccxDir(), "index.db"), { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      text,
      key UNINDEXED,
      uuid UNINDEXED,
      kind UNINDEXED,
      tool UNINDEXED,
      session_id UNINDEXED,
      project UNINDEXED,
      ts UNINDEXED,
      file UNINDEXED,
      line UNINDEXED,
      side UNINDEXED,
      tokenize = 'porter unicode61'
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS keys(
      key TEXT PRIMARY KEY,
      file TEXT NOT NULL
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_keys_file ON keys(file)");
  db.run(`
    CREATE TABLE IF NOT EXISTS files(
      path TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      size INTEGER NOT NULL,
      session_id TEXT,
      project TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions(
      session_id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      cwd TEXT,
      branch TEXT,
      model TEXT,
      title TEXT,
      first_prompt TEXT,
      first_ts TEXT,
      last_ts TEXT,
      entry_count INTEGER NOT NULL DEFAULT 0,
      file TEXT NOT NULL
    )
  `);
  return db;
}

export type SessionRow = {
  session_id: string;
  project: string;
  cwd: string | null;
  branch: string | null;
  model: string | null;
  title: string | null;
  first_prompt: string | null;
  first_ts: string | null;
  last_ts: string | null;
  entry_count: number;
  file: string;
};

/** Resolve a session by id prefix. Throws if ambiguous or missing. */
export function resolveSession(db: Database, prefix: string): SessionRow {
  const rows = db
    .prepare<SessionRow, [string]>(
      "SELECT * FROM sessions WHERE session_id LIKE ? || '%' ORDER BY last_ts DESC LIMIT 5",
    )
    .all(prefix);
  if (rows.length === 0) {
    throw new Error(`No session matching "${prefix}" (run: ccx index)`);
  }
  if (rows.length > 1) {
    const list = rows.map((r) => `  ${r.session_id}  ${r.title ?? r.first_prompt ?? ""}`).join("\n");
    throw new Error(`Ambiguous session prefix "${prefix}":\n${list}`);
  }
  return rows[0]!;
}
