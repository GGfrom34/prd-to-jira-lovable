import { test } from "node:test";
import assert from "node:assert/strict";
import { counters, freshDb, newSession, pgliteStore } from "./helpers/pglite-store.ts";

const DAY1 = "2026-10-20";
const DAY2 = "2026-10-21";
const BIG = { global: 1_000_000, visitor: 1_000_000, session: 1_000_000 };

async function setup() {
  const db = await freshDb();
  const store = pgliteStore(db);
  const session = await newSession(db, "v1");
  return { db, store, session };
}

test("a new session starts at step 'new' with no tokens used", async () => {
  const { db, session } = await setup();
  const res = await db.query<{ step: string; revision_count: number; tokens_used: number }>(
    "select step, revision_count, tokens_used::int as tokens_used from sessions where id = $1::uuid",
    [session],
  );
  assert.deepEqual(res.rows[0], { step: "new", revision_count: 0, tokens_used: 0 });
});

test("reserve adds the estimate to the global, visitor and session counters", async () => {
  const { db, store, session } = await setup();
  const r = await store.reserve({ day: DAY1, visitor: "v1", session, estimate: 1000, caps: BIG });
  assert.equal(r, "ok");
  assert.deepEqual(await counters(db, DAY1, "v1", session), { global: 1000, visitor: 1000, session: 1000 });
});

test("each cap denies with its own reason and leaves counters untouched", async () => {
  const cases = [
    { caps: { global: 500, visitor: 1_000_000, session: 1_000_000 }, reason: "global_cap" },
    { caps: { global: 1_000_000, visitor: 500, session: 1_000_000 }, reason: "visitor_cap" },
    { caps: { global: 1_000_000, visitor: 1_000_000, session: 500 }, reason: "session_cap" },
  ];
  for (const c of cases) {
    const { db, store, session } = await setup();
    const r = await store.reserve({ day: DAY1, visitor: "v1", session, estimate: 1000, caps: c.caps });
    assert.equal(r, c.reason);
    assert.deepEqual(await counters(db, DAY1, "v1", session), { global: 0, visitor: 0, session: 0 });
  }
});

test("a reservation that exactly reaches the cap is allowed, one more is not", async () => {
  const { store, session } = await setup();
  const caps = { global: 1000, visitor: 1000, session: 1000 };
  assert.equal(await store.reserve({ day: DAY1, visitor: "v1", session, estimate: 1000, caps }), "ok");
  assert.equal(await store.reserve({ day: DAY1, visitor: "v1", session, estimate: 1, caps }), "global_cap");
});

test("20 simultaneous reserves admit exactly floor(cap / estimate)", async () => {
  const { db, store } = await setup();
  const caps = { global: 1000, visitor: 1_000_000, session: 1_000_000 };
  const sessions = await Promise.all(Array.from({ length: 20 }, (_, i) => newSession(db, `v${i}`)));
  const results = await Promise.all(
    sessions.map((s, i) => store.reserve({ day: DAY1, visitor: `v${i}`, session: s, estimate: 300, caps })),
  );
  assert.equal(results.filter((r) => r === "ok").length, 3);
  assert.equal(results.filter((r) => r === "global_cap").length, 17);
});

test("settle refunds an over-estimate and charges an under-estimate", async () => {
  const { db, store, session } = await setup();
  await store.reserve({ day: DAY1, visitor: "v1", session, estimate: 1000, caps: BIG });
  await store.settle({ day: DAY1, visitor: "v1", session, estimate: 1000, actual: 400 });
  assert.deepEqual(await counters(db, DAY1, "v1", session), { global: 400, visitor: 400, session: 400 });

  await store.reserve({ day: DAY1, visitor: "v1", session, estimate: 100, caps: BIG });
  await store.settle({ day: DAY1, visitor: "v1", session, estimate: 100, actual: 250 });
  assert.deepEqual(await counters(db, DAY1, "v1", session), { global: 650, visitor: 650, session: 650 });
});

test("settle never takes a counter below zero", async () => {
  const { db, store, session } = await setup();
  await store.reserve({ day: DAY1, visitor: "v1", session, estimate: 100, caps: BIG });
  await store.settle({ day: DAY1, visitor: "v1", session, estimate: 5000, actual: 0 });
  assert.deepEqual(await counters(db, DAY1, "v1", session), { global: 0, visitor: 0, session: 0 });
});

test("an overshoot from settle makes the next reservation fail", async () => {
  const { store, session } = await setup();
  const caps = { global: 1000, visitor: 1_000_000, session: 1_000_000 };
  await store.reserve({ day: DAY1, visitor: "v1", session, estimate: 500, caps });
  await store.settle({ day: DAY1, visitor: "v1", session, estimate: 500, actual: 1200 });
  assert.equal(await store.reserve({ day: DAY1, visitor: "v1", session, estimate: 10, caps }), "global_cap");
});

test("a call that straddles midnight settles against the day it reserved", async () => {
  const { db, store, session } = await setup();
  await store.reserve({ day: DAY1, visitor: "v1", session, estimate: 1000, caps: BIG });
  await store.reserve({ day: DAY2, visitor: "v1", session, estimate: 200, caps: BIG });
  await store.settle({ day: DAY1, visitor: "v1", session, estimate: 1000, actual: 300 });
  const day1 = await counters(db, DAY1, "v1", session);
  const day2 = await counters(db, DAY2, "v1", session);
  assert.equal(day1.global, 300);
  assert.equal(day2.global, 200);
});

test("the daily counters roll over at the UTC date change", async () => {
  const { store, session } = await setup();
  const caps = { global: 1000, visitor: 1000, session: 1_000_000 };
  assert.equal(await store.reserve({ day: DAY1, visitor: "v1", session, estimate: 1000, caps }), "ok");
  assert.equal(await store.reserve({ day: DAY1, visitor: "v1", session, estimate: 1, caps }), "global_cap");
  assert.equal(await store.reserve({ day: DAY2, visitor: "v1", session, estimate: 1000, caps }), "ok");
});

test("the visitor cap is per visitor, the global cap is shared", async () => {
  const { db, store, session } = await setup();
  const other = await newSession(db, "v2");
  const caps = { global: 1_000_000, visitor: 1000, session: 1_000_000 };
  assert.equal(await store.reserve({ day: DAY1, visitor: "v1", session, estimate: 1000, caps }), "ok");
  assert.equal(await store.reserve({ day: DAY1, visitor: "v1", session, estimate: 1, caps }), "visitor_cap");
  assert.equal(await store.reserve({ day: DAY1, visitor: "v2", session: other, estimate: 1000, caps }), "ok");
});

test("the kill switch disables reservations, and a missing row fails closed", async () => {
  const { db, store, session } = await setup();
  const args = { day: DAY1, visitor: "v1", session, estimate: 10, caps: BIG };

  await db.exec("update config set value = 'false' where key = 'enabled'");
  assert.equal(await store.reserve(args), "disabled");

  await db.exec("delete from config where key = 'enabled'");
  assert.equal(await store.reserve(args), "disabled");

  await db.exec("insert into config (key, value) values ('enabled', 'true')");
  assert.equal(await store.reserve(args), "ok");
});

test("an unknown session is denied and nothing is charged", async () => {
  const { db, store } = await setup();
  const ghost = "00000000-0000-0000-0000-000000000000";
  const r = await store.reserve({ day: DAY1, visitor: "v1", session: ghost, estimate: 10, caps: BIG });
  assert.equal(r, "no_session");
  const res = await db.query<{ n: number }>("select coalesce(sum(used), 0)::int as n from token_usage");
  assert.equal(res.rows[0].n, 0);
});

test("a non-positive estimate is rejected", async () => {
  const { store, session } = await setup();
  for (const estimate of [0, -5]) {
    await assert.rejects(store.reserve({ day: DAY1, visitor: "v1", session, estimate, caps: BIG }));
  }
});

test("capacity_available reflects headroom and the kill switch", async () => {
  const { db, store, session } = await setup();
  const avail = async () =>
    (await db.query<{ a: boolean }>("select capacity_available($1::date, 1000, 300) as a", [DAY1])).rows[0].a;

  assert.equal(await avail(), true);
  await store.reserve({ day: DAY1, visitor: "v1", session, estimate: 800, caps: BIG });
  assert.equal(await avail(), false);

  await store.settle({ day: DAY1, visitor: "v1", session, estimate: 800, actual: 100 });
  assert.equal(await avail(), true);

  await db.exec("update config set value = 'false' where key = 'enabled'");
  assert.equal(await avail(), false);
});

test("purge_old removes old counters and sessions but keeps recent ones", async () => {
  const { db, store, session } = await setup();
  await store.reserve({ day: DAY1, visitor: "v1", session, estimate: 10, caps: BIG });
  await store.reserve({ day: DAY2, visitor: "v1", session, estimate: 10, caps: BIG });
  const old = await newSession(db, "old");
  await db.query("update sessions set created_at = now() - interval '49 hours' where id = $1::uuid", [old]);

  await db.query("select purge_old($1::date)", [DAY2]);

  const days = await db.query<{ day: string }>("select day::text as day from token_usage group by day order by day");
  assert.deepEqual(days.rows.map((r) => r.day), [DAY2]);
  const ids = await db.query<{ id: string }>("select id from sessions");
  assert.deepEqual(ids.rows.map((r) => r.id), [session]);
});

test("the browser-facing roles cannot read the tables or call the functions", async () => {
  const { db, session } = await setup();
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(db.query("select * from token_usage"), /permission denied/);
      await assert.rejects(db.query("select * from sessions"), /permission denied/);
      await assert.rejects(db.query("select * from config"), /permission denied/);
      await assert.rejects(
        db.query("select reserve_tokens('2026-10-20', 'v1', $1::uuid, 10, 1, 1, 1)", [session]),
        /permission denied/,
      );
    } finally {
      await db.exec("reset role");
    }
  }
});

test("service_role works even if the platform stops granting new tables by default", async () => {
  const db = await freshDb({ withDefaultGrants: false });
  const session = await newSession(db, "v1");
  await db.exec("set role service_role");
  try {
    const res = await db.query<{ r: string }>(
      "select reserve_tokens('2026-10-20', 'v1', $1::uuid, 10, 100, 100, 100) as r",
      [session],
    );
    assert.equal(res.rows[0].r, "ok");
    await db.query("select begin_step($1::uuid, array['new'])", [session]);
  } finally {
    await db.exec("reset role");
  }
});

test("service_role can use the functions", async () => {
  const { db, session } = await setup();
  await db.exec("set role service_role");
  try {
    const res = await db.query<{ r: string }>(
      "select reserve_tokens('2026-10-20', 'v1', $1::uuid, 10, 100, 100, 100) as r",
      [session],
    );
    assert.equal(res.rows[0].r, "ok");
  } finally {
    await db.exec("reset role");
  }
});
