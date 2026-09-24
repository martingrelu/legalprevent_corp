// Ejecuta la versión publicada de la función (que llama a Deno.serve al
// importarse) dentro del laboratorio, con el mismo contrato que la nueva:
// handleRequest(request, { env, fetch }).
let captured = null;
let currentEnv = () => undefined;
globalThis.Deno = { serve: (handler) => { captured = handler; }, env: { get: (name) => currentEnv(name) } };
// Nota: el gateway importa la función nueva ANTES que este módulo, para que
// la nueva no vea este Deno simulado y no intente arrancar su propio servidor.
await import(process.env.LAB_PUBLISHED_FUNCTION);

export async function handleRequest(request, deps) {
  const originalFetch = globalThis.fetch;
  currentEnv = deps.env;
  globalThis.fetch = deps.fetch;
  try {
    return await captured(request);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
