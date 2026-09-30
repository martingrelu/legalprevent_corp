// Historial firmado con HMAC-SHA256: en modo público el texto de la
// conversación no se guarda en nuestra base; viaja con el navegador y el
// servidor comprueba que nadie lo ha manipulado (p. ej. turnos del asistente
// inventados para inducir al modelo).

export type Turn = { r: "u" | "a"; x: string };
export type AgentState = { v: 1; c: string; n: number; t: Turn[] };

const encoder = new TextEncoder();

const b64url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = (text: string) => {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

export async function signState(state: AgentState, secret: string): Promise<string> {
  const body = b64url(encoder.encode(JSON.stringify(state)));
  return `${body}.${b64url(await hmac(secret, body))}`;
}

export async function verifyState(token: string, secret: string): Promise<AgentState | null> {
  const [body, signature, extra] = String(token || "").split(".");
  if (!body || !signature || extra !== undefined || token.length > 60000) return null;
  const expected = await hmac(secret, body);
  let given: Uint8Array;
  try {
    given = fromB64url(signature);
  } catch {
    return null;
  }
  if (given.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) diff |= given[i] ^ expected[i];
  if (diff !== 0) return null;
  try {
    const state = JSON.parse(new TextDecoder().decode(fromB64url(body))) as AgentState;
    if (state.v !== 1 || typeof state.c !== "string" || !Number.isInteger(state.n) || !Array.isArray(state.t)) return null;
    return state;
  } catch {
    return null;
  }
}

export function newConversationId() {
  return b64url(crypto.getRandomValues(new Uint8Array(18)));
}

// Marcador secreto en las instrucciones: si aparece en una respuesta, el modelo
// ha filtrado sus instrucciones. Derivado del secreto: nunca está en el código.
export async function canaryFor(secret: string) {
  return `LP-CANARY-${b64url(await hmac(secret, "canary")).slice(0, 12)}`;
}
