// Extracción de texto de HTML (sin dependencias). No es un parser completo: es suficiente para comprobar que una
// cita aparece literalmente en una página oficial y para leer su título. Ante la duda NO se da por válida.
import { normalizeText } from "./text.mjs";

const NAMED = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", Uuml: "Ü", agrave: "à",
  egrave: "è", ograve: "ò", ccedil: "ç", iexcl: "¡", iquest: "¿", laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘",
  rsquo: "’", ndash: "–", mdash: "—", hellip: "…", euro: "€", deg: "°", ordm: "º", ordf: "ª", copy: "©", reg: "®", sect: "§",
  middot: "·", bull: "•",
};

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return Object.hasOwn(NAMED, entity) ? NAMED[entity] : match;
  });
}

const BLOCKS = "p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|section|article|aside|blockquote|hr|form|dt|dd|dl|main|figure|figcaption|pre";
const DROP = /<(script|style|noscript|svg|template|nav|header|footer)\b[\s\S]*?<\/\1\s*>/gi;

// Texto visible: se descartan scripts, estilos, menús y pies; las etiquetas de bloque separan palabras y las
// de línea (a, em, strong…) no, para que "del <a>Reglamento</a>, establece" quede como "del Reglamento, establece".
export function htmlToText(html) {
  return normalizeText(
    decodeEntities(
      String(html)
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(DROP, " ")
        .replace(new RegExp(`</?(?:${BLOCKS})\\b[^>]*>`, "gi"), " ")
        .replace(/<[^>]+>/g, "")
    )
  );
}

export const extractTitle = (html) => {
  const match = String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? normalizeText(decodeEntities(match[1].replace(/<[^>]+>/g, ""))) : null;
};

export const extractHeadings = (html) =>
  [...String(html).matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((match) => normalizeText(decodeEntities(match[1].replace(/<[^>]+>/g, "")))).filter(Boolean);

export const FINGERPRINT_CHARS = 1000;

// Ventana de contenido para detectar cambios: desde el primer <h1> (la identidad del documento) hasta un tope de
// caracteres. Excluye los menús que van antes y la ventana de acceso que va después, que cambian sin que cambie la
// fuente (en las páginas reales del INSST también varía el HTML crudo por un token de sesión en cada descarga).
// La CITA sí se busca en el texto completo; esta ventana solo sirve para la huella de deriva (un cambio posterior en
// el texto de la página no se detecta con ella; el documento PDF se vigila aparte por el hash de sus bytes).
export function contentWindow(text, headings, max = FINGERPRINT_CHARS) {
  const start = headings.length ? text.indexOf(headings[0]) : -1;
  return text.slice(Math.max(start, 0), Math.max(start, 0) + max);
}
