// Separación entre las FUENTES OFICIALES y el contenido generado por IA.
//
// Regla: lo que genera un modelo es un borrador. Un borrador solo puede tocar el propio artículo en estado
// draft / in_review. No puede tocar el registro de fuentes, los reconocimientos de revisión (`review_ack`), la
// aprobación, las firmas ni el código o la CI: eso es revisión y autorización humanas.
// Los candados (`lock`) sí pueden venir de un proceso automático, porque los produce y autentica el verificador
// contra la fuente oficial (verify-sources.mjs --check), no el modelo.
//
// `changes` = [{ path, before, after, mode }] con el contenido (texto) antes y después (null si no existía o se borra) y el
// modo de git del fichero resultante ("100644" = fichero regular; un enlace simbólico, un submódulo o un ejecutable no
// son un artículo).
// Se aplica a los cambios de origen "generator". Lo integra el CI en F2.3.
//
// El ORIGEN se decide por el AUTOR, no por el nombre de la rama: el nombre de la rama lo elige quien abre la PR y
// se puede falsear. Por defecto, todo lo que no es del responsable se trata como generado (denegar por defecto).
import { parseRaw } from "../blog-render.mjs";

export const GENERATOR_BRANCH_PREFIX = "seo/";
export const ARTICLE_PATH = /^content\/blog\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const ARTICLE = ARTICLE_PATH;
const DRAFT_STATES = ["draft", "in_review"];
const PROTECTED_FIELDS = ["approved_at", "approval", "review_ack"];

// Solo es "human" si el autor es el responsable. Una rama `seo/…` del propio responsable también se trata como
// generada (más estricto, nunca más laxo).
export function originOf({ author, humanLogin, branch }) {
  if (!humanLogin || String(author ?? "").toLowerCase() !== String(humanLogin).toLowerCase()) return "generator";
  return String(branch ?? "").startsWith(GENERATOR_BRANCH_PREFIX) ? "generator" : "human";
}

function metaOf(text) {
  try {
    return parseRaw(text, "artículo").meta;
  } catch {
    return null;
  }
}

export function separationProblems({ origin, changes }) {
  if (origin !== "generator") return [];
  const problems = [];
  for (const { path, before, after, mode } of changes) {
    if (!ARTICLE.test(path)) {
      problems.push(`${path}: un borrador generado por IA solo puede tocar content/blog/<slug>.md`);
      continue;
    }
    if (after != null && mode !== undefined && mode !== "100644") {
      problems.push(`${path}: un borrador generado solo puede añadir ficheros regulares (modo ${mode}: enlace simbólico, submódulo o ejecutable)`);
      continue;
    }
    const was = before == null ? null : metaOf(before);
    const now = after == null ? null : metaOf(after);
    if (was && !DRAFT_STATES.includes(was.review_status)) problems.push(`${path}: no se puede modificar ni borrar un artículo aprobado desde un borrador generado`);
    if (after == null) continue;
    if (!now) {
      problems.push(`${path}: el artículo no tiene un front matter válido`);
      continue;
    }
    if (!DRAFT_STATES.includes(now.review_status)) problems.push(`${path}: un borrador generado no puede dejar el artículo en "${now.review_status}"`);
    for (const field of PROTECTED_FIELDS) {
      const same = JSON.stringify(was?.[field] ?? null) === JSON.stringify(now[field] ?? null);
      if (!same) problems.push(`${path}: un borrador generado no puede añadir ni cambiar "${field}" (revisión y autorización humanas)`);
    }
  }
  return problems;
}
