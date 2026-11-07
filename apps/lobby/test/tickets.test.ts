import assert from "node:assert/strict";
import { test } from "node:test";
import { b64urlDecode, b64urlEncode, courses, mintTicket } from "../src/tickets.ts";

/** Seed [7; 32], as in the Rust tests. */
const SEED = b64urlEncode(new Uint8Array(32).fill(7));

/**
 * Ed25519 is deterministic, so this exact token is what the lobby signs for
 * these claims. `crates/protocol/src/token.rs` verifies the same string, so
 * the two sides can't drift apart.
 */
const GP_TOKEN =
  "eyJ2IjoxLCJhdWQiOiJyYWNlLmV4YW1wbGU6NDQzIiwicm9vbSI6Im1fdGVzdCIsInBpZCI6InVzZXJfMSIsIm5hbWUiOiJMb3JkIEt5bGlhbiMwMDQyIiwiZXhwIjoxMDAwNjAwLCJpYXQiOjEwMDAwMDAsImJvdHMiOjcsInN1cmZhY2UiOjEsImNvdXJzZSI6MCwiZXZlbnRzIjpbMCwxXX0.3_soaIfoUK8Ujek_VchbKyUP_9Fzzep3homz5Mz1J0rWm1SkUsVAEEB8Kj1khh6aS7SSpSR8584JgtKMg7M0DA";

void test("a Tilt ticket names every course, signed in the token format", async () => {
  assert.deepEqual(courses("gp"), [0, 1]);
  assert.deepEqual(courses("winter"), [1]);
  const ticket = await mintTicket(
    SEED,
    {
      server: { addr: "race.example:443", version: "1.2.3", certHashes: ["abc", "def"] },
      room: "m_test",
      pid: "user_1",
      name: "Lord Kylian#0042",
      event: "gp",
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
  "eyJ2IjoxLCJhdWQiOiJyYWNlLmV4YW1wbGU6NDQzIiwicm9vbSI6Im1fdGVzdCIsInBpZCI6InVzZXJfMSIsIm5hbWUiOiJMb3JkIEt5bGlhbiMwMDQyIiwiZXhwIjoxMDAwNjAwLCJpYXQiOjEwMDAwMDAsImJvdHMiOjcsInN1cmZhY2UiOjEsImNvdXJzZSI6MCwiZXZlbnRzIjpbMCwxXSwibG9vayI6IkFRQUJBZ00iLCJzZXR1cHMiOltbMywzLDMsM10sWzYsMiwyLDJdXX0.1tSmr7BgiTu6PSO6_gr6O_t5PqiFcJX9mDsXAyW8lYHBoAn9LD5NKL6NxyeTqhZQhIkQQ607nZsMmVAY-U1JBw";

void test("a ticket carries the rider's appearance and setups", async () => {
  const ticket = await mintTicket(
    SEED,
    {
      server: { addr: "race.example:443", version: "1.2.3", certHashes: [] },
      room: "m_test",
      pid: "user_1",
      name: "Lord Kylian#0042",
      event: "gp",
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
