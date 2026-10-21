// Saneado de texto no confiable para logs y resúmenes de Actions (seo-engine/ci/sanitize.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { annotation, escapeData, escapeProperty, markdownCode, safeText } from "../seo-engine/ci/sanitize.mjs";

test("safeText sustituye controles, saltos de línea y caracteres bidi/invisibles, y acota la longitud", () => {
  assert.equal(safeText("a\nb\rc\td\u0000e\u001bf\u007fg"), "a�b�c�d�e�f�g");
  for (const ch of ["​", "‎", " ", " ", "‪", "‮", "⁦", "⁩", "﻿", "\u0085"]) assert.equal(safeText(`x${ch}y`), "x�y", JSON.stringify(ch));
  assert.equal(safeText(undefined), "");
  assert.equal(safeText(null), "");
  assert.equal(safeText(12), "12");
  assert.equal(safeText("a".repeat(500), 10), `${"a".repeat(10)}…`);
  assert.equal(safeText("texto normal con ñ y tildes áé"), "texto normal con ñ y tildes áé");
});

test("escapeData/escapeProperty siguen el protocolo de comandos de workflow", () => {
  assert.equal(escapeData("100%\r\nfin"), "100%25%0D%0Afin");
  assert.equal(escapeProperty("a:b,c"), "a%3Ab%2Cc");
});

test("annotation produce una única línea, con nivel permitido, y neutraliza cargas hostiles", () => {
  const line = annotation("error", "mal\n::set-output name=x::1\r\n::error::falso", "t\nitulo: x, y");
  assert.ok(!/[\n\r]/.test(line));
  assert.match(line, /^::error title=[^:,\n]*::/);
  assert.equal((line.match(/^::/gm) ?? []).length, 1);
  assert.throws(() => annotation("debug", "x"), /nivel/);
  assert.throws(() => annotation("set-env", "x"), /nivel/);
  assert.equal(annotation("warning", "ok"), "::warning::ok");
  assert.ok(annotation("error", "x".repeat(5000)).length < 520, "mensaje acotado");
});

test("markdownCode no permite romper el código en línea ni la tabla", () => {
  const out = markdownCode("a`b|c\\d\n<script>");
  assert.match(out, /^`[^`\n]*`$/);
  assert.ok(!out.slice(1, -1).includes("|"));
});
