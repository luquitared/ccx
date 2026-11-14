// `-m` and `--user` against a stand-in for lofiwave's /api/ccx, with a scratch CCX_DIR and no transcripts.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cli.ts");
let dir = "";
let server: ReturnType<typeof Bun.serve>;
const seen: string[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ccx-remote-"));
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== "Bearer good") return Response.json({ error: "unauthorized" }, { status: 401 });
      seen.push(url.pathname + url.search);
      if (url.pathname === "/api/ccx") return Response.json({ available: true, machine: "boxhost", os_user: "agent", users: ["agent", "Dana K"] });
      if (url.pathname === "/api/ccx/search") {
        const hit = { session: "aaaaaaaa-0000-4000-8000-000000000000", project: "api", title: "Fix deploy", kind: "user", tool: null, timestamp: "2026-01-02T03:04:05Z", file: "/h/a.jsonl", line: 7, sidechain: false, snippet: "deploy failed", show: "ccx show aaaaaaaa --line 7", user: "Dana K" };
        return Response.json({ machine: "boxhost", results: [hit] });
      }
      if (url.pathname === "/api/ccx/sessions") return Response.json({ machine: "boxhost", sessions: [{ session: "aaaaaaaa-0000-4000-8000-000000000000", project: "api", cwd: "/w/api", branch: null, model: null, title: "Fix deploy", first_prompt: null, first_ts: null, last_ts: "2026-01-02T03:04:05Z", entries: 9, user: "Dana K" }] });
      if (url.pathname === "/api/ccx/show") return Response.json({ machine: "boxhost", file: "/h/a.jsonl", total_blocks: 30, blocks: [{ line: 7, uuid: "u", kind: "user", tool: null, timestamp: null, text: "deploy failed again" }] });
      return Response.json({ error: `no route for GET ${url.pathname}` }, { status: 404 });
    },
  });
});
afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function ccx(...args: string[]) {
  const proc = Bun.spawn(["bun", CLI, ...args], { env: { ...process.env, CCX_DIR: dir, CCX_CLAUDE_DIRS: "", NO_COLOR: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}

test("remote add keeps the machine in an owner-only file and checks it answers", async () => {
  const r = await ccx("remote", "add", "box", `http://127.0.0.1:${server.port}/`, "--token", "good");
  expect(r.code).toBe(0);
  expect(r.out).toContain("ok");
  expect(r.out).toContain("users: agent, Dana K");
  expect(statSync(join(dir, "remotes.json")).mode & 0o777).toBe(0o600);
  expect((await ccx("remote", "add", "all", "http://x", "--token", "t")).code).toBe(1);
  expect((await ccx("remote", "add", "bad", `http://127.0.0.1:${server.port}`, "--token", "wrong")).out).toContain("token rejected");
  expect((await ccx("remote", "remove", "bad")).code).toBe(0);
});

test("search -m sends the filters and marks each hit with its machine and user", async () => {
  seen.length = 0;
  const r = await ccx("search", "deploy failed", "-m", "box", "--user", "dana", "-p", "api", "-k", "user", "--main", "-n", "5", "--json");
  const q = new URL("http://x" + seen[0]).searchParams;
  expect(Object.fromEntries(q)).toEqual({ q: "deploy failed", project: "api", kind: "user", limit: "5", main: "1", user: "dana" });
  const hit = JSON.parse(r.out).results[0];
  expect(hit.machine).toBe("box");
  expect(hit.user).toBe("Dana K");
  expect(hit.show).toBe("ccx show aaaaaaaa --line 7 -m box");
  expect((await ccx("search", "deploy", "-m", "box")).out).toContain("box (Dana K) · api");
});

test("--user asks every remote and leaves the local index out", async () => {
  seen.length = 0;
  const r = await ccx("sessions", "--user", "dana", "--json");
  expect(seen.length).toBe(1);
  expect(JSON.parse(r.out).sessions.map((s: any) => [s.machine, s.user])).toEqual([["box", "Dana K"]]);
  const local = await ccx("search", "x", "-m", "local", "--user", "dana");
  expect(local.code).toBe(1);
  expect(local.err).toContain("--user needs lofiwave");
});

test("show -m reads the slice from the machine", async () => {
  seen.length = 0;
  const r = await ccx("show", "aaaaaaaa", "--line", "7", "-C", "2", "-m", "box");
  expect(seen[0]).toBe("/api/ccx/show?target=aaaaaaaa&line=7&context=2");
  expect(r.out).toContain("showing 1 of 30 blocks · box:/h/a.jsonl");
  expect(r.out).toContain("deploy failed again");
});

test("a machine that doesn't answer is reported; the others still print", async () => {
  await ccx("remote", "add", "down", "http://127.0.0.1:1", "--token", "t");
  const r = await ccx("search", "deploy", "-m", "box,down", "--json");
  expect(r.code).toBe(0);
  const out = JSON.parse(r.out);
  expect(out.results.length).toBe(1);
  expect(out.errors[0].machine).toBe("down");
  expect(r.err).toContain("ccx: down: can't reach");
  expect((await ccx("search", "deploy", "-m", "down")).code).toBe(1);
  expect((await ccx("search", "deploy", "-m", "nope")).err).toContain('Unknown machine "nope" (have: box, down)');
});

test("share picks conversations one by one; shared --json is the list lofiwave reads", async () => {
  expect(JSON.parse((await ccx("shared", "--json")).out)).toEqual({ sessions: [] });
  // A session prefix that matches nothing changes nothing.
  const none = await ccx("share", "ffffffff");
  expect(none.code).toBe(1);
  expect(none.err).toContain('No session matching "ffffffff"');
  expect(JSON.parse((await ccx("shared", "--json")).out)).toEqual({ sessions: [] });
});
