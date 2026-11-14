import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addItem, board, findSecret, openWork, parseCheck, redact, similarity, WorkError } from "./work.ts";

const dir = mkdtempSync(join(tmpdir(), "ccx-work-"));
process.env.CCX_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fresh() {
  rmSync(join(dir, "work.db"), { force: true });
  rmSync(join(dir, "work.db-wal"), { force: true });
  rmSync(join(dir, "work.db-shm"), { force: true });
  const db = openWork();
  const at = new Date().toISOString();
  db.prepare("INSERT INTO streams(slug, name, created_at, updated_at) VALUES ('s', 'S', ?, ?)").run(at, at);
  return db;
}

describe("guards", () => {
  test("finds credentials in the shapes agents paste them", () => {
    expect(findSecret("key sk3_ok1cDSoTasPO_xyE8OqFEXvQ")).toBeTruthy();
    expect(findSecret("AKIAIOSFODNN7EXAMPLE")).toBeTruthy();
    expect(findSecret("Password: **hunter2hunter2**")).toBeTruthy();
    expect(findSecret("temporary password is `cSmbaVoog`")).toBeTruthy();
  });
  test("leaves ordinary sentences alone", () => {
    expect(findSecret("Rotate the password on the box")).toBeNull();
    expect(findSecret("Say where the token is kept")).toBeNull();
    expect(findSecret("Review the 5-minute stall failure in PR #21")).toBeNull();
  });
  test("redact removes the credential and keeps the rest", () => {
    const out = redact("use AKIAIOSFODNN7EXAMPLE to sign in");
    expect(out).toBe("use [redacted] to sign in");
  });
  test("only structured checks parse", () => {
    expect(parseCheck("pr:acme/app#12")).toEqual({ type: "pr", repo: "acme/app", number: 12 });
    expect(parseCheck("pr:acme/app#12; rm -rf /")).toBeNull();
    expect(parseCheck("cmd:rm -rf /")).toBeNull();
  });
  test("similarity sees rewordings but not neighbours", () => {
    expect(similarity("Merge the upload fix PR", "Merge the upload fix PR now")).toBeGreaterThanOrEqual(0.6);
    expect(similarity("Merge the upload fix PR", "Write the upload guide")).toBeLessThan(0.6);
  });
});

describe("items", () => {
  let db: ReturnType<typeof openWork>;
  beforeEach(() => { db = fresh(); });

  test("a near-duplicate is refused with exit code 3, and --force allows it", () => {
    addItem(db, { stream: "s", title: "Merge the upload fix PR", by: "t" });
    let err: unknown;
    try { addItem(db, { stream: "s", title: "Merge the upload fix PR now", by: "t" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WorkError);
    expect((err as WorkError).code).toBe(3);
    expect(addItem(db, { stream: "s", title: "Merge the upload fix PR now", force: true, by: "t" }).existed).toBe(false);
  });
  test("the same key returns the same item", () => {
    const a = addItem(db, { stream: "s", title: "one", key: "k", by: "t" });
    const b = addItem(db, { stream: "s", title: "something else", key: "k", by: "t" });
    expect(b.existed).toBe(true);
    expect(b.item.id).toBe(a.item.id);
  });
  test("a credential is refused and nothing is written", () => {
    expect(() => addItem(db, { stream: "s", title: "Login is fine", body: "password: hunter2hunter2", by: "t" })).toThrow(WorkError);
    expect(board(db).totals.open).toBe(0);
  });
  test("a person's name means waiting on them", () => {
    addItem(db, { stream: "s", title: "a", ball: "me", by: "t" });
    addItem(db, { stream: "s", title: "b", ball: "agent", by: "t" });
    addItem(db, { stream: "s", title: "c", ball: "pooyan", by: "t" });
    const t = board(db).totals;
    expect([t.me, t.agent, t.them]).toEqual([1, 1, 1]);
    expect(board(db, { on: "pooyan" }).streams[0]!.items.map((i) => i.title)).toEqual(["c"]);
  });
  test("what's due and high priority leads the stream", () => {
    addItem(db, { stream: "s", title: "plain", by: "t" });
    addItem(db, { stream: "s", title: "urgent thing", priority: "high", by: "t" });
    addItem(db, { stream: "s", title: "dated", due: "2020-01-01", by: "t" });
    expect(board(db).streams[0]!.items.map((i) => i.title)).toEqual(["dated", "urgent thing", "plain"]);
  });
});
