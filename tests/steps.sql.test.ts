import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, newSession, pgliteDb } from "./helpers/pglite-store.ts";

async function setup() {
  const pg = await freshDb();
  const db = pgliteDb(pg);
  const session = await newSession(pg, "v1");
  const row = async () =>
    (
      await pg.query<{ step: string; busy: boolean; revision_count: number }>(
        "select step, busy_since is not null as busy, revision_count from sessions where id = $1::uuid",
        [session],
      )
    ).rows[0];
  return { pg, db, session, row };
}

test("begin_step claims a session at an allowed step and marks it busy", async () => {
  const { db, session, row } = await setup();
  assert.equal(await db.beginStep(session, ["new"]), "ok");
  assert.deepEqual(await row(), { step: "new", busy: true, revision_count: 0 });
});

test("begin_step refuses a step that is not allowed, without marking the session busy", async () => {
  const { db, session, row } = await setup();
  assert.equal(await db.beginStep(session, ["reviewed", "finalized"]), "wrong_step");
  assert.equal((await row()).busy, false);
});

test("begin_step refuses a second claim while the first is still running", async () => {
  const { db, session } = await setup();
  assert.equal(await db.beginStep(session, ["new"]), "ok");
  assert.equal(await db.beginStep(session, ["new"]), "busy");
});

test("two simultaneous claims admit exactly one", async () => {
  const { db, session } = await setup();
  const results = await Promise.all([db.beginStep(session, ["new"]), db.beginStep(session, ["new"])]);
  assert.deepEqual(results.sort(), ["busy", "ok"]);
});

test("an unknown session is reported as no_session", async () => {
  const { db } = await setup();
  assert.equal(await db.beginStep("00000000-0000-0000-0000-000000000000", ["new"]), "no_session");
});

test("finish_step advances the step and releases the claim", async () => {
  const { db, session, row } = await setup();
  await db.beginStep(session, ["new"]);
  await db.finishStep(session, "reviewed");
  assert.deepEqual(await row(), { step: "reviewed", busy: false, revision_count: 0 });
  assert.equal(await db.beginStep(session, ["new"]), "wrong_step");
  assert.equal(await db.beginStep(session, ["reviewed"]), "ok");
});

test("abort_step releases the claim without moving the step, so the visitor can retry", async () => {
  const { db, session, row } = await setup();
  await db.beginStep(session, ["new"]);
  await db.abortStep(session);
  assert.deepEqual(await row(), { step: "new", busy: false, revision_count: 0 });
  assert.equal(await db.beginStep(session, ["new"]), "ok");
});

test("a claim older than the lease is ignored, so a crashed request cannot strand a session", async () => {
  const { db, pg, session } = await setup();
  await db.beginStep(session, ["new"]);
  await pg.query("update sessions set busy_since = now() - interval '4 minutes' where id = $1::uuid", [session]);
  assert.equal(await db.beginStep(session, ["new"]), "ok");

  await pg.query("update sessions set busy_since = now() - interval '2 minutes' where id = $1::uuid", [session]);
  assert.equal(await db.beginStep(session, ["new"]), "busy");
});

test("a second revision is impossible: revising moves the session past the only step that allows it", async () => {
  const { db, session, row } = await setup();
  for (const [from, to] of [
    ["new", "reviewed"],
    ["reviewed", "finalized"],
    ["finalized", "signed_off"],
    ["signed_off", "split_proposed"],
  ] as const) {
    assert.equal(await db.beginStep(session, [from, "reviewed"]), "ok");
    await db.finishStep(session, to);
  }
  assert.equal(await db.beginStep(session, ["split_proposed"]), "ok");
  await db.finishStep(session, "split_revised");
  assert.equal((await row()).revision_count, 1);
  assert.equal(await db.beginStep(session, ["split_proposed"]), "wrong_step");
});

test("finish_step rejects a step name that is not in the machine", async () => {
  const { db, session } = await setup();
  await assert.rejects(db.finishStep(session, "hacked" as never));
});

test("start_session enforces the per-visitor limit and counts visitors separately", async () => {
  const pg = await freshDb();
  const db = pgliteDb(pg);
  assert.ok(await db.startSession("a", 2));
  assert.ok(await db.startSession("a", 2));
  assert.equal(await db.startSession("a", 2), null);
  assert.ok(await db.startSession("b", 2));
});

test("parallel start_session calls cannot race past the limit", async () => {
  const pg = await freshDb();
  const db = pgliteDb(pg);
  const results = await Promise.all(Array.from({ length: 6 }, () => db.startSession("a", 3)));
  assert.equal(results.filter((r) => r !== null).length, 3);
});

test("the browser-facing roles cannot call the step functions", async () => {
  const { pg, session } = await setup();
  for (const role of ["anon", "authenticated"]) {
    await pg.exec(`set role ${role}`);
    try {
      await assert.rejects(pg.query("select begin_step($1::uuid, array['new'])", [session]), /permission denied/);
      await assert.rejects(pg.query("select finish_step($1::uuid, 'reviewed')", [session]), /permission denied/);
      await assert.rejects(pg.query("select abort_step($1::uuid)", [session]), /permission denied/);
      await assert.rejects(pg.query("select start_session('x', 5)"), /permission denied/);
    } finally {
      await pg.exec("reset role");
    }
  }
});
