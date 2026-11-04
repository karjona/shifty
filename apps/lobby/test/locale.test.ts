import assert from "node:assert/strict";
import { test } from "node:test";
import { pickLocale } from "../src/locale.ts";

void test("the best supported language from an Accept-Language list", () => {
  assert.equal(pickLocale("ca-ES,ca;q=0.9,es;q=0.8,en;q=0.7"), "ca");
  assert.equal(pickLocale("fr-FR,fr;q=0.9,es;q=0.5"), "es");
  assert.equal(pickLocale("de"), "en");
  assert.equal(pickLocale("es"), "es");
  assert.equal(pickLocale(null), "en");
});
