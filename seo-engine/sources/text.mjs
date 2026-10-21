// Normalización y comparación de citas (sin dependencias). Sirve para comprobar que una cita textual
// aparece LITERALMENTE en la fuente oficial, tolerando solo diferencias tipográficas.
import { createHash } from "node:crypto";

export const sha256Hex = (text) => createHash("sha256").update(String(text), "utf8").digest("hex");

const DOUBLE_QUOTES = /[“”„«»″]/g; // “ ” „ « » ″
const SINGLE_QUOTES = /[‘’‚′]/g; // ‘ ’ ‚ ′
const DASHES = /[‐-―−]/g; // ‐ ‑ ‒ – — ― −
const INVISIBLE = /[­​-‍﻿]/g; // guion blando, espacios de ancho cero, BOM

// NFKC (convierte "…" en "..." y NBSP en espacio), sin invisibles, comillas y guiones unificados y espacios
// colapsados. NO cambia mayúsculas/minúsculas ni palabras: la cita debe ser literal.
export function normalizeText(value) {
  return String(value)
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(DOUBLE_QUOTES, '"')
    .replace(SINGLE_QUOTES, "'")
    .replace(DASHES, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export const MIN_FRAGMENT = 8;

// Una cita puede omitir tramos con "[...]", "[…]", "..." o "…": cada fragmento debe aparecer, en orden.
export const quoteFragments = (quote) =>
  normalizeText(quote)
    .split(/\s*\[\s*\.\.\.\s*\]\s*|\s*\.\.\.\s*/)
    .map((fragment) => fragment.trim())
    .filter(Boolean);

export function quoteMatches(text, quote) {
  const haystack = normalizeText(text);
  const fragments = quoteFragments(quote);
  if (!fragments.length) return { ok: false, reason: "cita vacía" };
  let position = 0;
  for (const fragment of fragments) {
    if (fragment.length < MIN_FRAGMENT) return { ok: false, reason: `fragmento demasiado corto (mínimo ${MIN_FRAGMENT}): "${fragment}"` };
    const index = haystack.indexOf(fragment, position);
    if (index < 0) return { ok: false, missing: fragment };
    position = index + fragment.length;
  }
  return { ok: true };
}
