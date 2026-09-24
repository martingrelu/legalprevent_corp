// STUB DE EMERGENCIA para `smooth-action` (PR0).
//
// Úsalo solo si la función nueva falla en producción y no se puede corregir
// de inmediato. NO envía ningún email y no lee la base de datos: la captación
// de leads sigue funcionando (los leads se ven en el CRM), solo se pausan los
// avisos internos. Nunca vuelvas a publicar la versión anterior de la función:
// permitía enviar emails a direcciones arbitrarias.
const allowed = (Deno.env.get("ALLOWED_ORIGINS") || "https://legalprevent.com,https://www.legalprevent.com")
  .split(",")
  .map((origin) => origin.trim());

Deno.serve((request) => {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    Vary: "Origin",
  };
  if (origin && allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  return new Response(JSON.stringify({ ok: true, notified: false }), { status: 202, headers });
});
