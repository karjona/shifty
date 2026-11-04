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
  "eyJ2IjoxLCJhdWQiOiJyYWNlLmV4YW1wbGU6NDQzIiwicm9vbSI6Im1fdGVzdCIsInBpZCI6InVzZXJfMSIsIm5hbWUiOiJMb3JkIEt5bGlhbiMwMDQyIiwiZXhwIjoxMDAwNjAwLCJib3RzIjo3LCJzdXJmYWNlIjoxLCJjb3Vyc2UiOjAsImV2ZW50cyI6WzAsMV19.eMBZeAYgcGluX_xHlndGuqz7i133iyLf8hPvaRudW2izHmeXo8i8GCs3oagqLWlD-0CCo3RozYJEOvrg1eLeDw";

test("a Grand Prix ticket names every course, signed in the token format", async () => {
  assert.deepEqual(courses("gp"), [0, 1]);
  assert.deepEqual(courses("winter"), [1]);
  const ticket = await mintTicket(
    SEED,
    {
      server: { addr: "race.example:443", certHash: "abc" },
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
  assert.equal(ticket.certHash, "abc");
});
