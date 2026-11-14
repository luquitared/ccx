# ccx

Search and explore your Claude Code conversation history from the terminal.

Claude Code stores every session as JSONL under `~/.claude/projects/`, but gives you no way
to search it. `ccx` indexes every transcript, whatever directory the session ran in, into a
local SQLite **FTS5** index covering *everything* in them — user prompts, assistant replies, thinking blocks, tool calls (with inputs),
tool results, system messages, summaries, and titles — including subagent sidechain files,
and lets you query it with BM25 ranking in milliseconds.

Zero dependencies. Bun + `bun:sqlite` only.

## Install

```bash
git clone https://github.com/luquitared/ccx && cd ccx
bun link             # puts `ccx` on your PATH
ccx index            # first build (~2-3 min for 1.5GB of history, incremental after)
```

## Usage

```bash
ccx search "hono rpc body"                  # full-text search, BM25 ranked
ccx search "presigned url" -t Bash          # only Bash tool calls
ccx search "deploy failed" -p my-api -s 2w  # project + time filters
ccx search "rate limit" -k user --main      # only my prompts, no subagents
ccx search "s3 presign" --json -n 5         # machine-readable (for agents)

ccx show a7146289 --line 482 -C 8           # view 8 blocks around a search hit
ccx show a7146289 --tail 30                 # end of a session
ccx show a7146289 --around <uuid> --full    # untruncated, centered on an entry

ccx sessions -p my-api -s 1m                # list sessions, newest first
ccx resume 4e0d7f77                         # prints: cd <cwd> && claude -r <id>
ccx stats                                   # index size / coverage
ccx index                                   # incremental update (sub-second when idle)
ccx index --full                            # rebuild from scratch
```

Every search hit prints a ready-to-run `ccx show … --line N` command, so the loop is:
search → show the slice → optionally `ccx resume` the session.

## How it works

- **Sources**: every project under `~/.claude/projects`, `~/.config/claude/projects` and
  `$CLAUDE_CONFIG_DIR/projects`. Add more roots with `CCX_CLAUDE_DIRS=/a:/b`.
- **Index**: `~/.ccx/index.db`, an FTS5 table (`porter unicode61` tokenizer) plus small
  `sessions`/`files` metadata tables. Sync is mtime+size-diffed per file, so re-runs only
  touch changed sessions.
- **Lenient parsing**: unknown entry types are skipped, malformed lines ignored — schema
  drift across Claude Code versions never breaks indexing.
- **Dedup**: resumed/compacted sessions replay old entries into new files; entries are
  deduplicated globally by entry uuid so each block is indexed once.
- **Noise filtering**: injected `<system-reminder>` blocks (memory recall, hook output),
  slash-command wrappers, and meta entries are excluded from the index.
- **Caps**: tool inputs (2KB), tool results (4KB), and text blocks (16KB) are capped
  per-block, keeping the index a fraction of the transcript size.
- **Sidechains**: subagent transcripts are indexed and attributed to their parent session;
  exclude them with `--main`.

## Other machines and users (with lofiwave)

[lofiwave](https://github.com/luquitared/lofiwave) is a web console for the coding agents on a machine.
Where it runs next to ccx, it answers ccx searches over that machine's conversations, and knows who
started each session: on a box several people share, that is what tells their sessions apart.

```bash
# once per machine: its lofiwave URL, and its token or an API key from its Connect page
ccx remote add box https://box.example.com --token lw_…
ccx remote list                               # the machines, whether each answers, and their users

ccx search "presigned url" -m box             # search that machine
ccx search "presigned url" -m all             # this machine and every remote
ccx search "deploy failed" -m box --user dana # only sessions dana started
ccx sessions --user dana -s 2w                # dana's recent sessions, on every remote
ccx show a7146289 --line 482 -C 8 -m box      # read a hit where it lives
```

- **`-m, --machine`** takes a remote's name, several (`box,mini`), `local`, or `all`. Hits say which
  machine they are on, and their `ccx show …` line carries the `-m`. Each machine ranks its own hits;
  they are listed machine by machine, `-n` each. Without `-m`, nothing leaves this machine.
- **`--user`** is the name someone signs in to lofiwave with (their first name is enough). Sessions
  nobody started from the console, such as one run in a terminal, belong to the OS user lofiwave runs
  as. Only lofiwave knows users, so `--user` asks the remotes, not the local index: to filter this
  machine's sessions, add its own lofiwave as a remote.
- A machine that doesn't answer is reported on stderr (and under `errors` with `--json`) and the rest
  still print.
- The other machine needs ccx installed and a lofiwave with `/api/ccx`. The search runs there, so
  nothing is copied here; names, URLs and tokens are kept in `~/.ccx/remotes.json` (mode 600).

## Agent use: long-term memory for Claude

Claude starts every session with an empty head. With ccx it can look up earlier sessions the way
you would: search, read the few blocks that matter, carry on. `--json` on `search`, `show` and
`sessions` keeps it cheap: an agent pulls a ~10-block slice instead of a multi-MB transcript.

Just ask it to "use ccx":

| You say | Claude runs |
|---|---|
| "Find the session where I fine-tuned the model with LoRA. Which learning rate did we land on?" | `ccx search "lora learning rate" -k assistant` → `ccx show <id> --line <n> -C 10` |
| "Pull up the convo where we set up the agent on the remote machine and pick up where it left off." | `ccx sessions -q "remote machine" --json` → `ccx show <id> --tail 30 --json` |
| "How did we get that CLI to authenticate last month? Do it the same way." | `ccx search "cookies auth" -t Bash -s 2m` |
| "We found a bug in #337 recently. Was it actually intentional?" | `ccx search "337" -s 2w --main` → `ccx show <id> --line <n> -C 12` |
| "The DNS records are gone from the old registrar. What did we have before the move?" | `ccx search "dns records" -p blog -t Bash` → `ccx show <id> --line <n> -C 6` |
| "Go through my last three months of sessions. What have I built that I could turn into X?" | `ccx sessions -s 3m -n 200 --json` → `ccx search "<theme>" --json -n 30` |

To make it automatic, add this to `~/.claude/CLAUDE.md`:

```markdown
## Past conversations
`ccx` searches every past Claude Code session on this machine. When I refer to an
earlier conversation ("the session where…", "like last time", "we already fixed
this") or you need context you don't have:
1. Run `ccx index` (sub-second), then `ccx search "<terms>" --json -n 10`.
   Narrow with -p <project>, -s 2w, -k user, -t Bash, --main.
2. Read the best hits with `ccx show <session> --line <n> -C 10 --json`.
   Read slices, never whole transcripts.
3. Say what you found (date and session title), or that nothing matched.
If I want to jump back in, give me the `ccx resume <session>` line.
```

With remotes set up, add: "If it may have happened on another machine, or was someone else's
session, search with `-m all` (or `--user <name>`) and keep the `-m <machine>` on `ccx show`."

## Links

- Landing page: https://ccx.odapt.ai
- `site/` is that page (deployed with `wrangler deploy`); `assets/` holds the logo and the sources for the social preview image.

MIT licensed. Not affiliated with Anthropic.
