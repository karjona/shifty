import assert from "node:assert/strict";
import { test } from "node:test";
import { checkName, cleanName, formatHandle, nameKey } from "../src/handles.ts";

void test("names are 3-20 characters of letters, digits and a few separators", () => {
  assert.equal(checkName("Lord Kylian"), null);
  assert.equal(checkName("__xXMyNicknameXx__"), null);
  assert.equal(checkName("Ñandú"), null);
  assert.equal(checkName("Paral·lel"), null);
  assert.equal(checkName("Jo"), "short");
  assert.equal(checkName("a".repeat(21)), "long");
  assert.equal(checkName("bad<name>"), "chars");
  assert.equal(checkName("___"), "chars");
  assert.equal(checkName("😀😀😀"), "chars");
});

void test("reserved and rude names are refused, innocent look-alikes are not", () => {
  assert.equal(checkName("Admin"), "reserved");
  assert.equal(checkName("4dm1n"), "reserved");
  assert.equal(checkName("SHIFTY"), "reserved");
  assert.equal(checkName("xXfuckXx"), "rude");
  assert.equal(checkName("puta madre"), "rude");
  assert.equal(checkName("Computadora"), null);
  assert.equal(checkName("Balcony Rider"), null);
  assert.equal(checkName("Scunthorpe"), null);
});

void test("names compare without case, accents or separators", () => {
  assert.equal(nameKey("Lord Kylian"), nameKey("lord_kylian"));
  assert.equal(nameKey("Ñandú"), "nandu");
  assert.equal(cleanName("  Lord   Kylian "), "Lord Kylian");
  assert.equal(formatHandle("Lord Kylian", 42), "Lord Kylian#0042");
});
