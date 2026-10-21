// Saneado de TEXTO NO CONFIABLE antes de escribirlo en logs, anotaciones o resúmenes de GitHub Actions.
// Rutas de ficheros, nombres de rama, autores y mensajes de un PR los controla quien abre el PR: pueden llevar saltos de
// línea, secuencias "::" (comandos de workflow), marcado Markdown/HTML o caracteres de control y de dirección (bidi).
// Regla: ningún dato del PR llega al log sin pasar por aquí, y nunca puede empezar una línea (no hay saltos de línea).
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2069\\ufeff]", "g");

// Texto visible y de una sola línea, con tope de longitud. Los caracteres peligrosos se sustituyen por "�".
export const safeText = (value, max = 160) => {
  const text = String(value ?? "").replace(CONTROL, "�");
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

// Escapes que exige el protocolo de comandos de workflow (mensaje y propiedades).
export const escapeData = (text) => String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
export const escapeProperty = (text) => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");

// Anotación de workflow con datos saneados. `title` y `message` son siempre texto ya saneado.
export function annotation(level, message, title = "") {
  if (!["error", "warning", "notice"].includes(level)) throw new Error(`nivel de anotación inválido: ${level}`);
  const head = title ? ` title=${escapeProperty(safeText(title, 80))}` : "";
  return `::${level}${head}::${escapeData(safeText(message, 400))}`;
}

// Texto seguro para una celda o un código en línea de Markdown (resumen del job).
export const markdownCode = (value, max = 120) => `\`${safeText(value, max).replace(/[`|\\]/g, "ˋ")}\``;
