/**
 * Lenient extraction of searchable text from Claude Code JSONL entries.
 * One JSONL entry can yield multiple rows (assistant text + thinking + tool calls).
 * Unknown entry types are ignored; parsing never throws.
 */

export type Extracted = {
  key: string; // global dedup key (resumed sessions replay entries across files)
  uuid: string | null;
  kind:
    | "user"
    | "assistant"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "system"
    | "summary"
    | "title";
  tool: string | null;
  ts: string | null;
  line: number;
  text: string;
};

const TEXT_CAP = 16_000;
const INPUT_CAP = 2_000;
const RESULT_CAP = 4_000;

// Injected/boilerplate blocks that would pollute search results
// (e.g. MEMORY.md is replayed into every session via <system-reminder>).
const SKIP_PREFIXES = [
  "<system-reminder>",
  "<command-name>",
  "<local-command-stdout>",
  "Caveat: The messages below",
];

const shouldSkip = (t: string): boolean => {
  const s = t.trimStart();
  return SKIP_PREFIXES.some((p) => s.startsWith(p));
};

const safeJson = (v: unknown, cap: number): string => {
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
  } catch {
    s = String(v);
  }
  return s.slice(0, cap);
};

const toolResultText = (block: any): string => {
  const c = block?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text ?? "" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
};

export function extractEntry(e: any, file: string, line: number): Extracted[] {
  const out: Extracted[] = [];
  if (!e || typeof e !== "object" || e.isMeta) return out;

  const push = (
    kind: Extracted["kind"],
    text: string | null | undefined,
    opts: { tool?: string; seq?: number; cap?: number; keyOverride?: string } = {},
  ) => {
    if (!text || !text.trim() || shouldSkip(text)) return;
    const uuid = typeof e.uuid === "string" ? e.uuid : null;
    const seq = opts.seq ?? 0;
    const key =
      opts.keyOverride ??
      (uuid ? `${uuid}:${kind}:${seq}` : `${file}:${line}:${kind}:${seq}`);
    out.push({
      key,
      uuid,
      kind,
      tool: opts.tool ?? null,
      ts: typeof e.timestamp === "string" ? e.timestamp : null,
      line,
      text: text.slice(0, opts.cap ?? TEXT_CAP),
    });
  };

  switch (e.type) {
    case "user": {
      if (e.attachment) break; // hook outputs etc. — noise
      const c = e.message?.content;
      if (typeof c === "string") {
        push("user", c);
      } else if (Array.isArray(c)) {
        let seq = 0;
        const texts: string[] = [];
        for (const b of c) {
          if (typeof b === "string") texts.push(b);
          else if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
          else if (b?.type === "tool_result") {
            push("tool_result", toolResultText(b), { seq: seq++, cap: RESULT_CAP });
          }
        }
        push("user", texts.filter((t) => !shouldSkip(t)).join("\n"));
      }
      break;
    }
    case "assistant": {
      const c = e.message?.content;
      if (typeof c === "string") {
        push("assistant", c);
        break;
      }
      if (!Array.isArray(c)) break;
      let seq = 0;
      for (const b of c) {
        if (b?.type === "text") push("assistant", b.text, { seq: seq++ });
        else if (b?.type === "thinking") push("thinking", b.thinking, { seq: seq++ });
        else if (b?.type === "tool_use") {
          push("tool_use", `${b.name ?? "?"} ${safeJson(b.input, INPUT_CAP)}`, {
            tool: typeof b.name === "string" ? b.name : undefined,
            seq: seq++,
          });
        }
      }
      break;
    }
    case "system": {
      if (typeof e.content === "string") push("system", e.content, { cap: RESULT_CAP });
      break;
    }
    case "summary": {
      if (typeof e.summary === "string") {
        push("summary", e.summary, {
          keyOverride: e.leafUuid ? `sum:${e.leafUuid}` : undefined,
        });
      }
      break;
    }
    case "custom-title": {
      push("title", e.customTitle, { keyOverride: `ctitle:${file}` });
      break;
    }
    case "ai-title": {
      push("title", e.aiTitle, { keyOverride: `aititle:${file}` });
      break;
    }
    default:
      break;
  }
  return out;
}
