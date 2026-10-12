import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { resolveSession } from "./db.ts";
import { extractEntry, type Extracted } from "./extract.ts";
import {
  bold,
  cyan,
  dim,
  fmtDate,
  green,
  magenta,
  projectLabel,
  truncate,
  yellow,
} from "./util.ts";

export type ShowOpts = {
  line?: number;
  around?: string; // uuid
  context: number;
  head?: number;
  tail?: number;
  full: boolean;
  json: boolean;
};

const DISPLAY_CAPS: Record<string, number> = {
  user: 1500,
  assistant: 1500,
  thinking: 400,
  tool_use: 350,
  tool_result: 400,
  system: 300,
  summary: 600,
  title: 200,
};

export function runShow(db: Database, target: string, opts: ShowOpts) {
  let file: string;
  let header = "";
  if (target.includes("/") || target.endsWith(".jsonl")) {
    file = target;
    if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  } else {
    const s = resolveSession(db, target);
    file = s.file;
    const label = projectLabel(s.project, s.cwd);
    header = [
      bold(`${s.title ?? "(untitled)"}`),
      dim(
        `${s.session_id} · ${label}${s.branch ? " · " + s.branch : ""} · ${fmtDate(s.first_ts)} → ${fmtDate(s.last_ts)} · ${s.entry_count} entries${s.model ? " · " + s.model : ""}`,
      ),
      s.cwd ? dim(`resume: cd ${s.cwd} && claude -r ${s.session_id}`) : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const lines = readFileSync(file, "utf8").split("\n");
  const blocks: Extracted[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw) continue;
    let e: any;
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    blocks.push(...extractEntry(e, file, i + 1));
  }

  let selected: Extracted[];
  let note = "";
  if (opts.line !== undefined) {
    let center = blocks.findIndex((b) => b.line >= opts.line!);
    if (center === -1) center = blocks.length - 1;
    const start = Math.max(0, center - opts.context);
    const end = Math.min(blocks.length, center + opts.context + 1);
    selected = blocks.slice(start, end);
    note = `showing ${selected.length} of ${blocks.length} blocks around line ${opts.line}`;
  } else if (opts.around) {
    const center = blocks.findIndex((b) => b.uuid?.startsWith(opts.around!));
    if (center === -1) throw new Error(`No entry with uuid prefix ${opts.around}`);
    const start = Math.max(0, center - opts.context);
    const end = Math.min(blocks.length, center + opts.context + 1);
    selected = blocks.slice(start, end);
    note = `showing ${selected.length} of ${blocks.length} blocks around ${opts.around}`;
  } else if (opts.head !== undefined) {
    selected = blocks.slice(0, opts.head);
    note = `showing first ${selected.length} of ${blocks.length} blocks`;
  } else {
    const n = opts.tail ?? 40;
    selected = blocks.slice(-n);
    note =
      selected.length < blocks.length
        ? `showing last ${selected.length} of ${blocks.length} blocks (use --head/--line/--tail for more)`
        : `showing all ${blocks.length} blocks`;
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          file,
          total_blocks: blocks.length,
          blocks: selected.map((b) => ({
            line: b.line,
            uuid: b.uuid,
            kind: b.kind,
            tool: b.tool,
            timestamp: b.ts,
            text: opts.full ? b.text : b.text.slice(0, DISPLAY_CAPS[b.kind] ?? 1000),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (header) console.log(header + "\n");
  console.log(dim(`── ${note} ──\n`));
  for (const b of selected) {
    const ts = b.ts ? ` · ${fmtDate(b.ts)}` : "";
    const loc = dim(`L${b.line}`);
    switch (b.kind) {
      case "user":
        console.log(`${bold(cyan("● User"))}${dim(ts)} ${loc}`);
        break;
      case "assistant":
        console.log(`${bold(green("● Assistant"))}${dim(ts)} ${loc}`);
        break;
      case "thinking":
        console.log(`${magenta("○ Thinking")}${dim(ts)} ${loc}`);
        break;
      case "tool_use":
        console.log(`${yellow(`→ ${b.tool ?? "Tool"}`)}${dim(ts)} ${loc}`);
        break;
      case "tool_result":
        console.log(`${dim("← result")} ${loc}`);
        break;
      default:
        console.log(`${dim(`[${b.kind}]`)}${dim(ts)} ${loc}`);
    }
    const cap = DISPLAY_CAPS[b.kind] ?? 1000;
    const text = opts.full ? b.text : truncate(b.text, cap);
    console.log(text.replace(/^/gm, "  ") + "\n");
  }
}
