// Detector heurístico de inyección de instrucciones en el mensaje del
// visitante. Si salta, el mensaje NO se envía al modelo: se responde con el
// fallback comercial. No sustituye a las demás capas (instrucciones fijas,
// salida estructurada sin herramientas y validación de la salida).

const PATTERNS: Array<[string, RegExp]> = [
  ["ignorar_instrucciones", /\b(ignora|olvida|omite|salta(te)?|desactiva)\b[^.\n]{0,40}\b(instrucciones|reglas|restricciones|pol[ií]ticas|indicaciones)\b/i],
  ["ignore_instructions", /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(instructions|rules|prompt)\b/i],
  ["prompt_de_sistema", /\b(system\s*prompt|prompt\s+(de|del)\s+sistema|instrucciones\s+(de|del)\s+sistema|mensaje\s+(de|del)\s+sistema)\b/i],
  ["rol_falso", /(^|\n)\s*[\[<(]?\s*(system|sistema|developer|desarrollador|assistant|asistente|admin(istrador)?)\s*[\]>)]?\s*:/i],
  ["etiqueta_rol", /\[(system|sistema|developer|admin)\]|<\/?(system|developer)>/i],
  ["sin_restricciones", /\b(sin (ninguna )?restricci[oó]n(es)?|modo (desarrollador|developer|dios)|jailbreak|\bDAN\b|do anything now)\b/i],
  ["repetir_texto_previo", /\b(repite|copia|muestra|imprime|revela)\b[^.\n]{0,40}\b(palabra por palabra|literalmente|texto anterior|lo anterior|tus instrucciones|tu configuraci[oó]n|antes de)\b/i],
  ["codificado", /\b(ejecuta|decodifica|descodifica|interpreta|traduce y ejecuta)\b[\s\S]{0,40}[A-Za-z0-9+/]{24,}={0,2}/i],
  ["nuevo_rol", /\b(a partir de ahora|desde ahora)\b[^.\n]{0,30}\b(eres|act[uú]as? como|ser[aá]s)\b/i],
];

export function detectInjection(text: string): { suspicious: boolean; rule: string | null } {
  for (const [rule, pattern] of PATTERNS) {
    if (pattern.test(text)) return { suspicious: true, rule };
  }
  return { suspicious: false, rule: null };
}
