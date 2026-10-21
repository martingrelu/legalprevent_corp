// Normalización y comparación de citas (seo-engine/sources/text.mjs). Sin red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_FRAGMENT, normalizeText, quoteFragments, quoteMatches, sha256Hex } from "../seo-engine/sources/text.mjs";

test("normalizeText unifica comillas, guiones, espacios e invisibles, sin tocar mayúsculas ni palabras", () => {
  assert.equal(normalizeText("  “Hola” —‐ mundo­  \n  fin  "), '"Hola" -- mundo fin');
  assert.equal(normalizeText("l’ley ‘x’"), "l'ley 'x'");
  assert.equal(normalizeText("a​b﻿c"), "abc");
  assert.equal(normalizeText("Deber DE Confidencialidad"), "Deber DE Confidencialidad");
  assert.equal(normalizeText("etc…"), "etc...", "NFKC convierte la elipsis en tres puntos");
});

test("quoteMatches exige literalidad: mismas palabras y mayúsculas, solo tolera tipografía", () => {
  const text = "Las personas trabajadoras tienen derecho a solicitar las adaptaciones de la duración y distribución de la jornada.";
  assert.equal(quoteMatches(text, "tienen derecho a solicitar las adaptaciones").ok, true);
  assert.equal(quoteMatches(text, "tienen  derecho a   solicitar las adaptaciones").ok, true, "espacios");
  assert.equal(quoteMatches(text, "Tienen derecho a solicitar las adaptaciones").ok, false, "mayúsculas");
  assert.equal(quoteMatches(text, "tienen derecho a pedir las adaptaciones").ok, false, "palabras distintas");
  assert.deepEqual(quoteMatches(text, "tienen derecho a pedir las adaptaciones"), { ok: false, missing: "tienen derecho a pedir las adaptaciones" });
});

test("las omisiones con [...] o … se admiten, en orden y con fragmentos suficientes", () => {
  const text = "Los responsables y encargados del tratamiento así como todas las personas que intervengan estarán sujetas al deber de confidencialidad.";
  assert.deepEqual(quoteFragments("Los responsables y encargados […] estarán sujetas al deber"), ["Los responsables y encargados", "estarán sujetas al deber"]);
  assert.equal(quoteMatches(text, "Los responsables y encargados […] estarán sujetas al deber").ok, true);
  assert.equal(quoteMatches(text, "Los responsables y encargados [...] estarán sujetas al deber").ok, true);
  assert.equal(quoteMatches(text, "Los responsables y encargados … estarán sujetas al deber").ok, true);
  assert.equal(quoteMatches(text, "estarán sujetas al deber [...] Los responsables y encargados").ok, false, "fuera de orden");
  assert.match(quoteMatches(text, "Los responsables y encargados [...] deber").reason, /demasiado corto/);
  assert.equal(quoteMatches(text, "   ").ok, false);
  assert.ok(MIN_FRAGMENT >= 8);
});

test("sha256Hex es estable", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
