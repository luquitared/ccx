import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { extractEntry } from "./extract.ts";
import { UUID_RE, claudeDir, dim } from "./util.ts";

type FileRow = { mtime_ms: number; size: number };

export function runIndex(db: Database, opts: { full?: boolean; quiet?: boolean } = {}) {
  if (opts.full) {
    db.run("DELETE FROM fts");
    db.run("DELETE FROM keys");
    db.run("DELETE FROM files");
    db.run("DELETE FROM sessions");
  }

  const projectsDir = join(claudeDir(), "projects");
  if (!existsSync(projectsDir)) {
    throw new Error(`No Claude projects directory at ${projectsDir}`);
  }

  const getFile = db.prepare<FileRow, [string]>(
    "SELECT mtime_ms, size FROM files WHERE path = ?",
  );

  const started = Date.now();
  let scanned = 0;
  let indexed = 0;

  const slugs = readdirSync(projectsDir).filter((d) => {
    try {
      return statSync(join(projectsDir, d)).isDirectory();
    } catch {
      return false;
    }
  });

  for (const slug of slugs) {
    const dir = join(projectsDir, slug);
    const glob = new Bun.Glob("**/*.jsonl");
    for (const path of glob.scanSync({ cwd: dir, absolute: true })) {
      scanned++;
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      const mtime = Math.floor(st.mtimeMs);
      const prev = getFile.get(path);
      if (prev && prev.mtime_ms === mtime && prev.size === st.size) continue;
      indexFile(db, path, slug, dir, mtime, st.size);
      indexed++;
      if (!opts.quiet && indexed % 50 === 0) {
        process.stderr.write(dim(`  indexed ${indexed} files…\n`));
      }
    }
  }

  // Prune files that no longer exist on disk
  let pruned = 0;
  const known = db.prepare<{ path: string }, []>("SELECT path FROM files").all();
  for (const { path } of known) {
    if (existsSync(path)) continue;
    const del = db.transaction(() => {
      db.prepare("DELETE FROM fts WHERE file = ?").run(path);
      db.prepare("DELETE FROM keys WHERE file = ?").run(path);
      db.prepare("DELETE FROM files WHERE path = ?").run(path);
      db.prepare("DELETE FROM sessions WHERE file = ?").run(path);
    });
    del();
    pruned++;
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  return { scanned, indexed, pruned, secs };
}

function indexFile(
  db: Database,
  path: string,
  slug: string,
  projectDir: string,
  mtime: number,
  size: number,
) {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const lines = content.split("\n");
  const stem = basename(path, ".jsonl");
  const inProjectRoot = dirname(path) === projectDir;
  const isMain = inProjectRoot && UUID_RE.test(stem);
  // Sidechain agent files live under a directory named after the parent session
  // (directly, or nested e.g. <session>/subagents/agent-*.jsonl)
  let parentSession = stem;
  if (!inProjectRoot) {
    for (let d = dirname(path); d.startsWith(projectDir) && d !== projectDir; d = dirname(d)) {
      const name = basename(d);
      if (UUID_RE.test(name)) {
        parentSession = name;
        break;
      }
      parentSession = name;
    }
  }

  const insKey = db.prepare("INSERT OR IGNORE INTO keys(key, file) VALUES (?, ?)");
  const hasKey = db.prepare<{ key: string }, [string]>(
    "SELECT key FROM keys WHERE key = ?",
  );
  const insFts = db.prepare(
    `INSERT INTO fts(text, key, uuid, kind, tool, session_id, project, ts, file, line, side)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM fts WHERE file = ?").run(path);
    db.prepare("DELETE FROM keys WHERE file = ?").run(path);

    const sess = {
      cwd: null as string | null,
      branch: null as string | null,
      model: null as string | null,
      title: null as string | null,
      firstPrompt: null as string | null,
      firstTs: null as string | null,
      lastTs: null as string | null,
      count: 0,
    };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!.trim();
      if (!raw) continue;
      let e: any;
      try {
        e = JSON.parse(raw);
      } catch {
        continue;
      }
      sess.count++;
      if (typeof e.cwd === "string") sess.cwd = e.cwd;
      if (typeof e.gitBranch === "string" && e.gitBranch) sess.branch = e.gitBranch;
      if (typeof e.message?.model === "string") sess.model = e.message.model;
      if (typeof e.timestamp === "string") {
        if (!sess.firstTs) sess.firstTs = e.timestamp;
        sess.lastTs = e.timestamp;
      }
      if (e.type === "custom-title" && typeof e.customTitle === "string") {
        sess.title = e.customTitle;
      } else if (e.type === "ai-title" && typeof e.aiTitle === "string" && !sess.title) {
        sess.title = e.aiTitle;
      }

      const side = e.isSidechain || !isMain ? 1 : 0;
      for (const r of extractEntry(e, path, i + 1)) {
        if (!sess.firstPrompt && r.kind === "user" && side === 0) {
          sess.firstPrompt = r.text.slice(0, 300);
        }
        if (hasKey.get(r.key)) continue; // already indexed via another file (resume replay)
        insKey.run(r.key, path);
        insFts.run(
          r.text,
          r.key,
          r.uuid,
          r.kind,
          r.tool,
          parentSession,
          slug,
          r.ts,
          path,
          r.line,
          side,
        );
      }
    }

    db.prepare(
      `INSERT OR REPLACE INTO files(path, mtime_ms, size, session_id, project)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(path, mtime, size, parentSession, slug);

    if (isMain) {
      db.prepare(
        `INSERT OR REPLACE INTO sessions
           (session_id, project, cwd, branch, model, title, first_prompt,
            first_ts, last_ts, entry_count, file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        stem,
        slug,
        sess.cwd,
        sess.branch,
        sess.model,
        sess.title,
        sess.firstPrompt,
        sess.firstTs,
        sess.lastTs,
        sess.count,
        path,
      );
    }
  });
  tx();
}
