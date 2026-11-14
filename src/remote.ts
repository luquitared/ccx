/**
 * Other machines, reached through the lofiwave console running on them.
 *
 * lofiwave (https://github.com/luquitared/lofiwave) serves `/api/ccx/*`: it runs the ccx
 * installed on its machine and adds who each session belongs to, which only it knows (the
 * person signed in to the console who started the run). ccx keeps a name, URL and token per
 * machine in ~/.ccx/remotes.json and asks them with `-m <machine>` and `--user <name>`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bold, ccxDir, dim, green, red } from "./util.ts";

export type Remote = { url: string; token: string };

/** The local index, when it is named next to remotes. */
export const LOCAL = "local";
const ALL = "all";
const NAME_RE = /^[a-z0-9][a-z0-9_.-]*$/i;
const TIMEOUT_MS = 60_000;

const remotesFile = () => join(ccxDir(), "remotes.json");

export function loadRemotes(): Record<string, Remote> {
  if (!existsSync(remotesFile())) return {};
  try {
    return JSON.parse(readFileSync(remotesFile(), "utf8")) ?? {};
  } catch {
    throw new Error(`Cannot read ${remotesFile()} (not JSON)`);
  }
}

function saveRemotes(remotes: Record<string, Remote>) {
  mkdirSync(ccxDir(), { recursive: true });
  // Holds tokens: owner-only, also when the file already existed with wider permissions.
  writeFileSync(remotesFile(), JSON.stringify(remotes, null, 2) + "\n", { mode: 0o600 });
  chmodSync(remotesFile(), 0o600);
}

/**
 * Which indexes a command reads. No `-m` and no `--user` is the local index alone (null: the
 * caller keeps its local-only path). `-m` takes names separated by commas, `local`, or `all`
 * (local plus every remote). Only lofiwave knows users, so `--user` leaves the local index
 * out, and without `-m` asks every remote.
 */
export function pickMachines(
  spec: string | undefined,
  user: string | undefined,
): { local: boolean; remotes: string[] } | null {
  if (!spec && !user) return null;
  const known = Object.keys(loadRemotes());
  const names = (spec ?? ALL).split(",").map((s) => s.trim()).filter(Boolean);
  let local = false;
  const remotes: string[] = [];
  for (const name of names) {
    if (name === ALL) {
      local = !user;
      for (const k of known) if (!remotes.includes(k)) remotes.push(k);
    } else if (name === LOCAL) {
      if (user) {
        throw new Error(
          "--user needs lofiwave: the local index doesn't know who ran a session. Add this machine's lofiwave with `ccx remote add`.",
        );
      }
      local = true;
    } else if (!known.includes(name)) {
      throw new Error(
        `Unknown machine "${name}"` +
          (known.length ? ` (have: ${known.join(", ")})` : " (add one: ccx remote add <name> <url> --token <token>)"),
      );
    } else if (!remotes.includes(name)) {
      remotes.push(name);
    }
  }
  if (!local && remotes.length === 0) {
    throw new Error("No remote machines yet. Add one: ccx remote add <name> <url> --token <token>");
  }
  return { local, remotes };
}

/** GET a `/api/ccx…` path on a remote's lofiwave. Empty and undefined params are left out. */
export async function remoteGet(
  name: string,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<any> {
  const remote = loadRemotes()[name];
  if (!remote) throw new Error(`Unknown machine "${name}"`);
  const url = new URL(remote.url.replace(/\/+$/, "") + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "" || v === false) continue;
    url.searchParams.set(k, v === true ? "1" : String(v));
  }
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${remote.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e: any) {
    const why = e?.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000}s` : (e?.message ?? String(e));
    throw new Error(`can't reach ${remote.url} (${why})`);
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {}
  if (res.ok && data) return data;
  if (res.status === 401) throw new Error("token rejected (make an API key on lofiwave's Connect page)");
  if (res.status === 404 && (!data || String(data.error ?? "").startsWith("no route"))) {
    throw new Error("its lofiwave has no /api/ccx yet (update lofiwave there)");
  }
  throw new Error(data?.error ?? `HTTP ${res.status}`);
}

const HELP = `${bold("ccx remote")} — other machines, searched through their lofiwave console

  ccx remote add <name> <url> --token <t>   remember a machine (token: lofiwave's, or an API key
                                            from its Connect page; omit --token to read it from stdin)
  ccx remote list                           the machines and whether each answers
  ccx remote remove <name>
  ccx remote check [name]                   same as list, for one machine

Then: ccx search "<query>" -m <name|all>, ccx sessions -m <name>, ccx show <session> -m <name>,
and --user <name> for one person's sessions on a shared machine.
`;

async function describe(name: string, remote: Remote): Promise<boolean> {
  try {
    const s = await remoteGet(name, "/api/ccx");
    const users = Array.isArray(s.users) && s.users.length ? ` · users: ${s.users.join(", ")}` : "";
    const state = s.available ? green("ok") : red("ccx not installed there");
    // What an API key or a signed-in teammate finds there; the machine's own token finds everything.
    const shared = s.sharing === "all" ? " · team finds every conversation" : s.sharing === "picked" ? " · team finds only what its owner picked (ccx share)" : "";
    console.log(`${bold(name)}  ${remote.url}  ${state}${dim(` · host ${s.machine}${users}${shared}`)}`);
    return Boolean(s.available);
  } catch (e: any) {
    console.log(`${bold(name)}  ${remote.url}  ${red(e.message)}`);
    return false;
  }
}

export async function runRemote(argv: string[]) {
  const [sub, ...rest] = argv;
  const remotes = loadRemotes();
  switch (sub) {
    case "add": {
      const ti = rest.findIndex((a) => a === "--token" || a.startsWith("--token="));
      let token = "";
      if (ti >= 0) {
        const arg = rest[ti]!;
        token = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : (rest[ti + 1] ?? "");
        rest.splice(ti, arg.includes("=") ? 1 : 2);
      } else if (!process.stdin.isTTY) {
        token = await Bun.stdin.text();
      }
      token = token.trim();
      const [name, url] = rest;
      if (!name || !url) throw new Error("usage: ccx remote add <name> <url> --token <token>");
      if (!NAME_RE.test(name) || name === LOCAL || name === ALL) {
        throw new Error(`"${name}" can't be a machine name (letters, digits, - _ . ; not "local" or "all")`);
      }
      if (!/^https?:\/\/\S+$/.test(url)) throw new Error("the URL must start with http:// or https://");
      if (!token) throw new Error("a token is needed: --token <token>, or pipe it in on stdin");
      remotes[name] = { url: url.replace(/\/+$/, ""), token };
      saveRemotes(remotes);
      if (!(await describe(name, remotes[name]!))) process.exitCode = 1;
      break;
    }
    case "remove":
    case "rm": {
      const name = rest[0];
      if (!name || !remotes[name]) throw new Error(`No machine "${name ?? ""}"`);
      delete remotes[name];
      saveRemotes(remotes);
      console.log(`Removed ${name}`);
      break;
    }
    case undefined:
    case "list":
    case "ls":
    case "check": {
      const names = rest[0] ? [rest[0]] : Object.keys(remotes);
      if (rest[0] && !remotes[rest[0]]) throw new Error(`No machine "${rest[0]}"`);
      if (names.length === 0) {
        console.log(dim("No machines. Add one: ccx remote add <name> <url> --token <token>"));
        break;
      }
      const ok = await Promise.all(names.map((n) => describe(n, remotes[n]!)));
      if (ok.includes(false)) process.exitCode = 1;
      break;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      throw new Error(`unknown: ccx remote ${sub} (see: ccx remote help)`);
  }
}

/**
 * Ask every source at once and keep their order. A machine that fails is reported and left
 * out; the caller exits non-zero only when none answered.
 */
export async function gather<T>(
  sources: { name: string; get: () => Promise<T[]> | T[] }[],
): Promise<{ rows: (T & { machine: string })[]; errors: { machine: string; error: string }[] }> {
  const errors: { machine: string; error: string }[] = [];
  const parts = await Promise.all(
    sources.map(async (s) => {
      try {
        return (await s.get()).map((r) => ({ ...r, machine: s.name }));
      } catch (e: any) {
        errors.push({ machine: s.name, error: e?.message ?? String(e) });
        return [];
      }
    }),
  );
  return { rows: parts.flat(), errors };
}
