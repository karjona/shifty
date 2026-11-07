import assert from "node:assert/strict";
import { test } from "node:test";
import { b64urlDecode, b64urlEncode, legacyPlan, mintTicket } from "../src/tickets.ts";

/** Seed [7; 32], as in the Rust tests. */
const SEED = b64urlEncode(new Uint8Array(32).fill(7));

/**
 * Ed25519 is deterministic, so this exact token is what the lobby signs for
 * these claims. `crates/protocol/src/token.rs` verifies the same string, so
 * the two sides can't drift apart.
 */
const GP_TOKEN =
  "eyJ2IjoxLCJhdWQiOiJyYWNlLmV4YW1wbGU6NDQzIiwicm9vbSI6Im1fdGVzdCIsInBpZCI6InVzZXJfMSIsIm5hbWUiOiJMb3JkIEt5bGlhbiMwMDQyIiwiZXhwIjoxMDAwNjAwLCJpYXQiOjEwMDAwMDAsImJvdHMiOjcsInN1cmZhY2UiOjEsInRpbHQiOnRydWUsInNlZWQiOjEyMzR9.DdJtpWj_iW9tRRTMoUJafJmsqmPtNiJM6gSQDsEkfp5cmYyVpc2CVknRJmQo8aBQCHLeNXTBtosi56mjH4XfBw";

void test("a Tilt ticket carries its plan and seed, signed in the token format", async () => {
  assert.deepEqual(legacyPlan("gp"), { tilt: true });
  assert.deepEqual(legacyPlan("winter"), { tilt: false, race: { course: 1, season: 2 } });
  const ticket = await mintTicket(
    SEED,
    {
      server: { addr: "race.example:443", version: "1.2.3", certHashes: ["abc", "def"] },
      room: "m_test",
      pid: "user_1",
      name: "Lord Kylian#0042",
      plan: { tilt: true },
      seed: 1234,
      bots: 7,
    },
    1_000_000 * 1000,
  );
  assert.equal(ticket.token, GP_TOKEN);
  assert.equal(b64urlDecode(ticket.token.split(".")[1] ?? "").length, 64);
  assert.equal(ticket.webTransportUrl, "https://race.example:443/race");
  assert.equal(ticket.version, "1.2.3");
  assert.deepEqual(ticket.certHashes, ["abc", "def"]);
});

/** The same Tilt with a rider on it; `token.rs` verifies this one too. */
const RIDER_TOKEN =
  "eyJ2IjoxLCJhdWQiOiJyYWNlLmV4YW1wbGU6NDQzIiwicm9vbSI6Im1fdGVzdCIsInBpZCI6InVzZXJfMSIsIm5hbWUiOiJMb3JkIEt5bGlhbiMwMDQyIiwiZXhwIjoxMDAwNjAwLCJpYXQiOjEwMDAwMDAsImJvdHMiOjcsInN1cmZhY2UiOjEsInRpbHQiOnRydWUsInNlZWQiOjEyMzQsImxvb2siOiJBUUFCQWdNIiwic2V0dXBzIjpbWzMsMywzLDNdLFs2LDIsMiwyXV19.cbxZyTrC_R_95xTFm9R1SV6SgHwzqeQ77ciRhm4TJSDnZayRHDywrU7yE6u-dyIW95vnldo_j6217d2z6-gxAQ";

void test("a ticket carries the rider's appearance and setups", async () => {
  const ticket = await mintTicket(
    SEED,
    {
      server: { addr: "race.example:443", version: "1.2.3", certHashes: [] },
      room: "m_test",
      pid: "user_1",
      name: "Lord Kylian#0042",
      plan: { tilt: true },
      seed: 1234,
      bots: 7,
      rider: {
        look: "AQABAgM",
        setups: [
          [3, 3, 3, 3],
          [6, 2, 2, 2],
        ],
      },
    },
    1_000_000 * 1000,
  );
  assert.equal(ticket.token, RIDER_TOKEN);
});

/** A Tilt for three people; `token.rs` verifies this one too. */
const HUMANS_TOKEN =
  "eyJ2IjoxLCJhdWQiOiJyYWNlLmV4YW1wbGU6NDQzIiwicm9vbSI6Im1fdGVzdCIsInBpZCI6InVzZXJfMSIsIm5hbWUiOiJMb3JkIEt5bGlhbiMwMDQyIiwiZXhwIjoxMDAwNjAwLCJpYXQiOjEwMDAwMDAsImJvdHMiOjUsInN1cmZhY2UiOjEsInRpbHQiOnRydWUsInNlZWQiOjEyMzQsImh1bWFucyI6M30.C4Gw4OeSZtKdwBiVUH-OpSPNvIdZVgxEcFY-gUj4Ur8BVTqazF1F2Qjo8Lyu3_QMeviRKU9PQOI36mBHDHUYDQ";

void test("a ticket tells the race server how many people are coming", async () => {
  const ticket = await mintTicket(
    SEED,
    {
      server: { addr: "race.example:443", version: "1.2.3", certHashes: [] },
      room: "m_test",
      pid: "user_1",
      name: "Lord Kylian#0042",
      plan: { tilt: true },
      seed: 1234,
      bots: 5,
      humans: 3,
    },
    1_000_000 * 1000,
  );
  assert.equal(ticket.token, HUMANS_TOKEN);
});

/** One race with some picks; `token.rs` verifies this one too. */
const RACE_TOKEN =
  "eyJ2IjoxLCJhdWQiOiJyYWNlLmV4YW1wbGU6NDQzIiwicm9vbSI6Im1fdGVzdCIsInBpZCI6InVzZXJfMSIsIm5hbWUiOiJMb3JkIEt5bGlhbiMwMDQyIiwiZXhwIjoxMDAwNjAwLCJpYXQiOjEwMDAwMDAsImJvdHMiOjMsInN1cmZhY2UiOjEsInJhY2VzIjpbeyJjb3Vyc2UiOjEsInNlYXNvbiI6Miwid2VhdGhlciI6NSwidGltZSI6OTZ9XSwic2VlZCI6NDAwMDAwMDAwMH0.PRNOIsoyeYkw078EfO-RVa_ZZwoYM_iMrVI9yh_pJgdm9YCTJxzGtfxIYpNrkCtp3AQ8QdZqjiYAj7wSfYxGBA";

void test("a ticket for one race carries its picks, the rest left to the draw", async () => {
  const ticket = await mintTicket(
    SEED,
    {
      server: { addr: "race.example:443", version: "1.2.3", certHashes: [] },
      room: "m_test",
      pid: "user_1",
      name: "Lord Kylian#0042",
      plan: { tilt: false, race: { time: 96, season: 2, course: 1, weather: 5 } },
      seed: 4_000_000_000,
      bots: 3,
    },
    1_000_000 * 1000,
  );
  assert.equal(ticket.token, RACE_TOKEN);
});
