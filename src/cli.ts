#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { openDb } from "./db.ts";
import { runIndex } from "./indexer.ts";
import { LOCAL, gather, pickMachines, remoteGet, runRemote } from "./remote.ts";
import { printHits, printResults, search, toResults, type Result } from "./search.ts";
import { listSessions, printSessions, runResume, runSessions, runStats, type SessionOut } from "./sessions.ts";
import { printBlocks, runShow } from "./show.ts";
import { bold, dim, parseWhen, printOut, red } from "./util.ts";

const HELP = `${bold("ccx")} — search your Claude Code conversation history

${bold("Usage")}
  ccx index [--full]                 build/update the search index (~/.ccx/index.db)
  ccx search <query> [options]       full-text search (BM25) across all sessions
  ccx show <session|file> [options]  view a slice of a conversation
  ccx sessions [options]             list sessions, newest first
  ccx resume <session>               print the command to resume a session
  ccx stats                          index statistics
  ccx remote [help]                  other machines, through their lofiwave (see: ccx remote help)

${bold("search options")}
  -p, --project <s>    filter by project (substring of project dir)
  -s, --since <t>      only entries after (12h, 3d, 2w, 1m, or a date)
  -u, --until <t>      only entries before
  -k, --kind <k>       user | assistant | thinking | tool_use | tool_result | system | summary | title
  -t, --tool <name>    tool_use entries for a specific tool (Bash, Edit, …)
      --session <id>   restrict to one session (prefix ok)
      --main           exclude subagent/sidechain entries
      --raw            pass query through as raw FTS5 syntax (AND/OR/NEAR/*)
  -m, --machine <m>    search other machines: a name from \`ccx remote\`, a,b, local, or all
      --user <name>    only sessions that person started (needs lofiwave; all remotes unless -m)
  -n, --limit <n>      max results (default 15)
      --json           JSON output

${bold("show options")}
  --line <n>           center on JSONL line n (as printed by search)
  --around <uuid>      center on an entry uuid
  -C, --context <n>    blocks of context around center (default 6)
  --head <n> / --tail <n>   first/last n blocks (default: tail 40)
  --full               don't truncate long blocks
  -m, --machine <m>    the session is on that machine
  --json               JSON output

${bold("sessions options")}
  -p, --project <s>   -s, --since <t>   -q, --query <s> (title/first prompt)
  -n, --limit <n> (default 25)   --json   -m, --machine <m>   --user <name>

${bold("Examples")}
  ccx index
  ccx search "hono rpc body" -p claude-code-viewer
  ccx search "launchctl" -t Bash -s 2w
  ccx search "s3 presign" --json -n 5
  ccx show a7146289 --line 482 -C 8
  ccx sessions -p my-api -s 1m
  ccx remote add box https://box.example.com --token lw_…
  ccx search "launchctl" -m all            # this machine and every remote
  ccx search "deploy" -m box --user dana   # dana's sessions on box
  ccx show a7146289 --line 482 -m box
`;

function fail(msg: string): never {
  console.error(red(`ccx: ${msg}`));
  process.exit(1);
}

/** Drop rows already seen, keeping the first: a machine that is also a remote answers twice under `-m all`. */
function distinct<T>(rows: T[], key: (r: T) => string): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(key(r)) && seen.add(key(r)));
}

/** Say which machines didn't answer; fail only when none did. */
function report(errors: { machine: string; error: string }[], asked: { local: boolean; remotes: string[] }) {
  for (const e of errors) console.error(red(`ccx: ${e.machine}: ${e.error}`));
  if (errors.length && errors.length === asked.remotes.length + (asked.local ? 1 : 0)) process.exitCode = 1;
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
          machine: { type: "string", short: "m" },
          user: { type: "string" },
        },
      });
      const query = positionals.join(" ").trim();
      if (!query) fail("search needs a query");
      const opts = {
        project: values.project,
        since: values.since ? parseWhen(values.since) : undefined,
        until: values.until ? parseWhen(values.until) : undefined,
        kind: values.kind,
        tool: values.tool,
        session: values.session,
        mainOnly: values.main,
        raw: values.raw,
        limit: Number(values.limit) || 15,
      };
      const machines = pickMachines(values.machine, values.user);
      if (!machines) {
        const db = openDb();
        printHits(db, search(db, query, opts), values.json);
        break;
      }
      const { rows, errors } = await gather<Result>([
        ...(machines.local
          ? [{ name: LOCAL, get: () => { const db = openDb(); return toResults(db, search(db, query, opts)); } }]
          : []),
        ...machines.remotes.map((name) => ({
          name,
          get: async () => {
            const { mainOnly, ...rest } = opts;
            const r = await remoteGet(name, "/api/ccx/search", { q: query, ...rest, main: mainOnly, user: values.user });
            return (r.results as Result[]).map((x) => ({ ...x, show: `${x.show} -m ${name}` }));
          },
        })),
      ]);
      printResults(distinct(rows, (r) => `${r.session}\0${r.line}\0${r.kind}\0${r.snippet}`), values.json, errors);
      report(errors, machines);
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
          machine: { type: "string", short: "m" },
        },
      });
      const target = positionals[0];
      if (!target) fail("show needs a session id (prefix) or file path");
      if (values.machine && values.machine !== LOCAL) {
        const r = await remoteGet(values.machine, "/api/ccx/show", {
          target,
          line: values.line,
          around: values.around,
          context: values.context,
          head: values.head,
          tail: values.tail,
          full: values.full,
        });
        if (values.json) printOut(JSON.stringify(r, null, 2));
        else printBlocks(r.blocks, `showing ${r.blocks.length} of ${r.total_blocks} blocks · ${values.machine}:${r.file}`, values.full);
        break;
      }
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
          machine: { type: "string", short: "m" },
          user: { type: "string" },
        },
      });
      const opts = {
        project: values.project,
        since: values.since ? parseWhen(values.since) : undefined,
        query: values.query,
        limit: Number(values.limit) || 25,
      };
      const machines = pickMachines(values.machine, values.user);
      if (!machines) {
        runSessions(openDb(), { ...opts, json: values.json });
        break;
      }
      const { rows, errors } = await gather<SessionOut>([
        ...(machines.local ? [{ name: LOCAL, get: () => listSessions(openDb(), opts) }] : []),
        ...machines.remotes.map((name) => ({
          name,
          get: async () =>
            (await remoteGet(name, "/api/ccx/sessions", { ...opts, user: values.user })).sessions as SessionOut[],
        })),
      ]);
      // Newest first across machines, like one machine's list.
      const sessions = distinct(rows, (r) => r.session).sort((a, b) => (b.last_ts ?? "").localeCompare(a.last_ts ?? ""));
      printSessions(sessions, values.json, errors);
      report(errors, machines);
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

    case "remote": {
      await runRemote(argv.slice(1));
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
