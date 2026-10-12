import type { Database } from "bun:sqlite";
import type { SessionRow } from "./db.ts";
import { resolveSession } from "./db.ts";
import { bold, cyan, dim, fmtDate, oneLine, projectLabel } from "./util.ts";

export function runSessions(
  db: Database,
  opts: {
    project?: string;
    since?: string;
    query?: string;
    limit: number;
    json: boolean;
  },
) {
  const params: (string | number)[] = [];
  let sql = "SELECT * FROM sessions WHERE 1=1";
  if (opts.project) {
    sql += " AND project LIKE ?";
    params.push(`%${opts.project}%`);
  }
  if (opts.since) {
    sql += " AND last_ts >= ?";
    params.push(opts.since);
  }
  if (opts.query) {
    sql += " AND (title LIKE ? OR first_prompt LIKE ?)";
    params.push(`%${opts.query}%`, `%${opts.query}%`);
  }
  sql += " ORDER BY last_ts DESC LIMIT ?";
  params.push(opts.limit);

  const rows = db.prepare<SessionRow, (string | number)[]>(sql).all(...params);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          sessions: rows.map((r) => ({
            session: r.session_id,
            project: projectLabel(r.project, r.cwd),
            cwd: r.cwd,
            branch: r.branch,
            model: r.model,
            title: r.title,
            first_prompt: r.first_prompt,
            first_ts: r.first_ts,
            last_ts: r.last_ts,
            entries: r.entry_count,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (rows.length === 0) {
    console.log(dim("No sessions. Run: ccx index"));
    return;
  }
  for (const r of rows) {
    const label = (r.title ?? oneLine(r.first_prompt ?? "(no prompt)")).slice(0, 80);
    console.log(
      `${dim(r.session_id.slice(0, 8))}  ${fmtDate(r.last_ts).padEnd(13)} ${cyan(projectLabel(r.project, r.cwd).padEnd(26).slice(0, 26))} ${dim(String(r.entry_count).padStart(5))}  ${label}`,
    );
  }
}

export function runResume(db: Database, prefix: string) {
  const s = resolveSession(db, prefix);
  const cd = s.cwd ? `cd ${s.cwd} && ` : "";
  console.log(`${cd}claude -r ${s.session_id}`);
}

export function runStats(db: Database) {
  const one = <T>(sql: string): T =>
    db.prepare<Record<string, T>, []>(sql).values()[0]![0] as T;
  const sessions = one<number>("SELECT COUNT(*) FROM sessions");
  const files = one<number>("SELECT COUNT(*) FROM files");
  const rows = one<number>("SELECT COUNT(*) FROM fts");
  const oldest = one<string | null>("SELECT MIN(first_ts) FROM sessions");
  const newest = one<string | null>("SELECT MAX(last_ts) FROM sessions");
  const byKind = db
    .prepare<{ kind: string; n: number }, []>(
      "SELECT kind, COUNT(*) n FROM fts GROUP BY kind ORDER BY n DESC",
    )
    .all();
  console.log(`${bold("ccx index")}`);
  console.log(`  sessions   ${sessions}`);
  console.log(`  files      ${files}`);
  console.log(`  fts rows   ${rows}`);
  console.log(`  range      ${fmtDate(oldest)} → ${fmtDate(newest)}`);
  console.log(`  by kind    ${byKind.map((k) => `${k.kind}:${k.n}`).join("  ")}`);
}
