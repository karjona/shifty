import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPEARANCE_MAX_BYTES,
  ITEMS,
  MODELS,
  REQUIRED,
  SPORTS,
  STARTER,
  botAppearance,
  decodeAppearance,
  defaultOutfits,
  encodeAppearance,
  fitKit,
  fromBase64Url,
  kitProblem,
  normalizeLook,
  parseSetup,
  randomLook,
  rng,
  toBase64Url,
  validSetup,
} from "../src/index.ts";

const starter = new Set(STARTER.map((i) => i.id));

void test("item numbers and ids are unique, and every item's model exists", () => {
  assert.equal(new Set(ITEMS.map((i) => i.n)).size, ITEMS.length);
  assert.equal(new Set(ITEMS.map((i) => i.id)).size, ITEMS.length);
  const models = new Set(MODELS.map((m) => m.id));
  for (const i of ITEMS) assert.ok(models.has(i.model), i.id);
  for (const i of ITEMS) assert.ok(i.n > 0 && i.n < 65536, i.id);
});

void test("both bodies start in a complete kit for every sport", () => {
  for (const body of ["male", "female"] as const) {
    const outfits = defaultOutfits(body);
    for (const sport of SPORTS) {
      assert.equal(
        kitProblem(sport, outfits[sport], body, (id) => starter.has(id)),
        null,
        `${body} ${sport}`,
      );
      for (const slot of REQUIRED[sport]) assert.ok(outfits[sport][slot], `${body} ${sport} ${slot}`);
    }
  }
});

void test("kits refuse items from the wrong slot, the wrong body, or not owned", () => {
  const kit = { ...defaultOutfits("male").summer };
  assert.match(
    kitProblem("summer", { ...kit, bottom: "summer.bottom.swimsuit.black" }, "male", () => true) ?? "",
    /fit/,
  );
  assert.match(
    kitProblem("summer", { ...kit, head: "winter.head.beanie.white" }, "male", () => true) ?? "",
    /doesn't go/,
  );
  assert.match(
    kitProblem("summer", { ...kit, vest: "summer.vest.race.orange" }, "male", (id) => starter.has(id)) ?? "",
    /owned/,
  );
  assert.match(kitProblem("summer", { ...kit, vest: undefined }, "male", () => true) ?? "", /required/);
  // Changing body swaps what no longer fits for the starter piece; what fits both stays.
  const hers = defaultOutfits("female").summer;
  assert.equal(fitKit("summer", { ...hers }, "male").bottom, "summer.bottom.boardshorts.navy");
  assert.equal(fitKit("summer", { ...kit }, "female").bottom, "summer.bottom.boardshorts.navy");
});

void test("appearances round-trip through their bytes, within the protocol's limit", () => {
  const next = rng(42);
  for (let i = 0; i < 200; i++) {
    const look = randomLook(next);
    const a = { look, outfits: defaultOutfits(look.body) };
    const bytes = encodeAppearance(a);
    assert.ok(bytes.length <= APPEARANCE_MAX_BYTES);
    assert.ok(APPEARANCE_MAX_BYTES <= 64, "LOOK_MAX_BYTES in crates/protocol");
    const back = decodeAppearance(fromBase64Url(toBase64Url(bytes))!);
    assert.deepEqual(back, a);
  }
  assert.equal(decodeAppearance(Uint8Array.from([9, 9, 9])), null);
  assert.equal(decodeAppearance(Uint8Array.from([1, 1, ...Array(11).fill(0), 0, 0, 7])), null);
});

void test("bots look the same on every client, and female bots wear no beard", () => {
  assert.deepEqual(botAppearance(7, 3), botAppearance(7, 3));
  for (let s = 0; s < 50; s++) {
    const a = botAppearance(s, s % 8);
    if (a.look.body === "female") assert.equal(a.look.facialHair, 0);
    assert.deepEqual(normalizeLook(a.look), a.look);
  }
});

void test("setups spend exactly the budget, each stat 0-6", () => {
  assert.ok(validSetup({ speed: 3, handling: 3, stability: 3, tricks: 3 }));
  assert.ok(validSetup({ speed: 6, handling: 6, stability: 0, tricks: 0 }));
  assert.equal(parseSetup({ speed: 6, handling: 6, stability: 6, tricks: 0 }), null);
  assert.equal(parseSetup({ speed: 7, handling: 5, stability: 0, tricks: 0 }), null);
  assert.equal(parseSetup({ speed: 3.5, handling: 2.5, stability: 3, tricks: 3 }), null);
  assert.equal(parseSetup("lots"), null);
});
