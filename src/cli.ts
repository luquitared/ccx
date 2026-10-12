#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { openDb } from "./db.ts";
import { runIndex } from "./indexer.ts";
import { printHits, search } from "./search.ts";
import { runResume, runSessions, runStats } from "./sessions.ts";
import { runShow } from "./show.ts";
import { bold, dim, parseWhen, red } from "./util.ts";

const HELP = `${bold("ccx")} — search your Claude Code conversation history

${bold("Usage")}
  ccx index [--full]                 build/update the search index (~/.ccx/index.db)
  ccx search <query> [options]       full-text search (BM25) across all sessions
  ccx show <session|file> [options]  view a slice of a conversation
  ccx sessions [options]             list sessions, newest first
  ccx resume <session>               print the command to resume a session
  ccx stats                          index statistics

${bold("search options")}
  -p, --project <s>    filter by project (substring of project dir)
  -s, --since <t>      only entries after (12h, 3d, 2w, 1m, or a date)
  -u, --until <t>      only entries before
  -k, --kind <k>       user | assistant | thinking | tool_use | tool_result | system | summary | title
  -t, --tool <name>    tool_use entries for a specific tool (Bash, Edit, …)
      --session <id>   restrict to one session (prefix ok)
      --main           exclude subagent/sidechain entries
      --raw            pass query through as raw FTS5 syntax (AND/OR/NEAR/*)
  -n, --limit <n>      max results (default 15)
      --json           JSON output

${bold("show options")}
  --line <n>           center on JSONL line n (as printed by search)
  --around <uuid>      center on an entry uuid
  -C, --context <n>    blocks of context around center (default 6)
  --head <n> / --tail <n>   first/last n blocks (default: tail 40)
  --full               don't truncate long blocks
  --json               JSON output

${bold("sessions options")}
  -p, --project <s>   -s, --since <t>   -q, --query <s> (title/first prompt)
  -n, --limit <n> (default 25)   --json

${bold("Examples")}
  ccx index
  ccx search "hono rpc body" -p claude-code-viewer
  ccx search "launchctl" -t Bash -s 2w
  ccx search "s3 presign" --json -n 5
  ccx show a7146289 --line 482 -C 8
  ccx sessions -p my-api -s 1m
`;

function fail(msg: string): never {
  console.error(red(`ccx: ${msg}`));
  process.exit(1);
}

const argv = Bun.argv.slice(2);
const cmd = argv[0];

try {
  switch (cmd) {
    case "index": {
      const { values } = parseArgs({
        args: argv.slice(1),
        options: {
          full: { type: "boolean", default: false },
          quiet: { type: "boolean", short: "q", default: false },
        },
      });
      const db = openDb();
      const r = runIndex(db, { full: values.full, quiet: values.quiet });
      console.log(
        `Indexed ${r.indexed} changed file(s) of ${r.scanned} scanned` +
          (r.pruned ? `, pruned ${r.pruned}` : "") +
          dim(` (${r.secs}s)`),
      );
      break;
    }

    case "search": {
      const { values, positionals } = parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        options: {
          project: { type: "string", short: "p" },
          since: { type: "string", short: "s" },
          until: { type: "string", short: "u" },
          kind: { type: "string", short: "k" },
          tool: { type: "string", short: "t" },
          session: { type: "string" },
          main: { type: "boolean", default: false },
          raw: { type: "boolean", default: false },
          limit: { type: "string", short: "n", default: "15" },
          json: { type: "boolean", default: false },
        },
      });
      const query = positionals.join(" ").trim();
      if (!query) fail("search needs a query");
      const db = openDb();
      const hits = search(db, query, {
        project: values.project,
        since: values.since ? parseWhen(values.since) : undefined,
        until: values.until ? parseWhen(values.until) : undefined,
        kind: values.kind,
        tool: values.tool,
        session: values.session,
        mainOnly: values.main,
        raw: values.raw,
        limit: Number(values.limit) || 15,
      });
      printHits(db, hits, values.json);
      break;
    }

    case "show": {
      const { values, positionals } = parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        options: {
          line: { type: "string" },
          around: { type: "string" },
          context: { type: "string", short: "C", default: "6" },
          head: { type: "string" },
          tail: { type: "string" },
          full: { type: "boolean", default: false },
          json: { type: "boolean", default: false },
        },
      });
      const target = positionals[0];
      if (!target) fail("show needs a session id (prefix) or file path");
      const db = openDb();
      runShow(db, target, {
        line: values.line !== undefined ? Number(values.line) : undefined,
        around: values.around,
        context: Number(values.context) || 6,
        head: values.head !== undefined ? Number(values.head) : undefined,
        tail: values.tail !== undefined ? Number(values.tail) : undefined,
        full: values.full,
        json: values.json,
      });
      break;
    }

    case "sessions": {
      const { values } = parseArgs({
        args: argv.slice(1),
        options: {
          project: { type: "string", short: "p" },
          since: { type: "string", short: "s" },
          query: { type: "string", short: "q" },
          limit: { type: "string", short: "n", default: "25" },
          json: { type: "boolean", default: false },
        },
      });
      const db = openDb();
      runSessions(db, {
        project: values.project,
        since: values.since ? parseWhen(values.since) : undefined,
        query: values.query,
        limit: Number(values.limit) || 25,
        json: values.json,
      });
      break;
    }

    case "resume": {
      const target = argv[1];
      if (!target) fail("resume needs a session id (prefix)");
      runResume(openDb(), target);
      break;
    }

    case "stats": {
      runStats(openDb());
      break;
    }

    case undefined:
    case "help":
    case "--help":
    case "-h": {
      console.log(HELP);
      break;
    }

    default:
      fail(`unknown command "${cmd}" (see: ccx help)`);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
