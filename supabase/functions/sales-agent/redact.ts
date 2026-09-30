// Redacción de datos personales ANTES de enviar nada al modelo o guardarlo.
// El visitante debe usar el formulario (con sus consentimientos) para dejar
// sus datos; en el chat se sustituyen por marcadores.

const RULES: Array<[keyof Found, RegExp, string]> = [
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  ["iban", /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){3,7}(?:[ -]?[A-Z0-9]{1,3})?\b/g, "[iban]"],
  ["documento", /\b(?:\d{8}[A-Za-z]|[XYZxyz]\d{7}[A-Za-z]|[ABCDEFGHJNPQRSUVWabcdefghjnpqrsuvw]\d{7}[0-9A-Ja-j])\b/g, "[documento]"],
  ["telefono", /(?:\+|00)?(?:34[\s.-]?)?\b[6-9](?:[\s.-]?\d){8}\b/g, "[teléfono]"],
];

export type Found = { email: number; iban: number; documento: number; telefono: number };

export function redact(text: string): { text: string; found: Found } {
  const found: Found = { email: 0, iban: 0, documento: 0, telefono: 0 };
  let out = text;
  for (const [kind, pattern, marker] of RULES) {
    out = out.replace(pattern, () => {
      found[kind] += 1;
      return marker;
    });
  }
  return { text: out, found };
}

export const hasPersonalData = (found: Found) => Object.values(found).some((n) => n > 0);
