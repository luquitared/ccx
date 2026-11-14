/**
 * The conversations this machine's owner lets teammates find through lofiwave.
 *
 * A lofiwave on a personal machine shares nothing until its owner picks sessions here, one by
 * one (a console a team signs in to shares all of them instead; see lofiwave's CCX_SHARE).
 * lofiwave reads the list with `ccx shared --json`. It is kept apart from the index
 * (~/.ccx/shared.json), which can be rebuilt; this can't.
 */
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionRow } from "./db.ts";
import { resolveSession } from "./db.ts";
import { ccxDir, cyan, dim, fmtDate, oneLine, printOut, projectLabel } from "./util.ts";

const sharedFile = () => join(ccxDir(), "shared.json");

export function loadShared(): string[] {
  if (!existsSync(sharedFile())) return [];
  try {
    const ids = JSON.parse(readFileSync(sharedFile(), "utf8"));
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    throw new Error(`Cannot read ${sharedFile()} (not JSON)`);
  }
}

function saveShared(ids: string[]) {
  mkdirSync(ccxDir(), { recursive: true });
  writeFileSync(sharedFile(), JSON.stringify(ids, null, 2) + "\n");
}

const describe = (s: SessionRow) =>
  `${dim(s.session_id.slice(0, 8))}  ${cyan(projectLabel(s.project, s.cwd))}  ${(s.title ?? oneLine(s.first_prompt ?? "(no prompt)")).slice(0, 80)}`;

/** `ccx share <session>…` / `ccx unshare <session>…`: every prefix must name one session, or nothing changes. */
export function runShare(db: Database, prefixes: string[], share: boolean) {
  if (prefixes.length === 0) throw new Error(`usage: ccx ${share ? "share" : "unshare"} <session>…`);
  const sessions = prefixes.map((p) => resolveSession(db, p));
  const ids = new Set(loadShared());
  for (const s of sessions) {
    const had = ids.has(s.session_id);
    if (share) ids.add(s.session_id);
    else ids.delete(s.session_id);
    const what = share ? (had ? "Already shared" : "Shared") : had ? "No longer shared" : "Wasn't shared";
    console.log(`${what}: ${describe(s)}`);
  }
  saveShared([...ids]);
}

/** `ccx shared`: what teammates can find here. `--json` is what lofiwave reads. */
export function runShared(db: Database, asJson: boolean) {
  const ids = loadShared();
  if (asJson) {
    printOut(JSON.stringify({ sessions: ids }, null, 2));
    return;
  }
  if (ids.length === 0) {
    console.log(dim("Nothing shared. Share a conversation with your team: ccx share <session>"));
    return;
  }
  const get = db.prepare<SessionRow, [string]>("SELECT * FROM sessions WHERE session_id = ?");
  for (const id of ids) {
    const s = get.get(id);
    console.log(s ? `${describe(s)}  ${dim(fmtDate(s.last_ts))}` : `${dim(id.slice(0, 8))}  ${dim("(no longer on this machine)")}`);
  }
}
