const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const planNames: Record<string, string> = {
  starter: "Starter",
  pyme: "Pyme",
  business: "Business",
  gestorias: "Gestorías"
};

const planEnvNames: Record<string, string> = {
  starter: "STRIPE_PRICE_STARTER",
  pyme: "STRIPE_PRICE_PYME",
  business: "STRIPE_PRICE_BUSINESS",
  gestorias: "STRIPE_PRICE_GESTORIAS"
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });

const insertCheckoutSession = async (payload: Record<string, unknown>) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return;

  await fetch(`${supabaseUrl}/rest/v1/checkout_sessions`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify(payload)
  });
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Método no permitido." }, 405);

  try {
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) return json({ error: "Falta STRIPE_SECRET_KEY en Supabase." }, 500);

    const body = await request.json();
    const plan = String(body.plan || "").toLowerCase();
    const priceId = Deno.env.get(planEnvNames[plan] || "");

    if (!planNames[plan] || !priceId) {
      return json({ error: "Plan no configurado en Stripe." }, 400);
    }

    const siteUrl = Deno.env.get("PUBLIC_SITE_URL") || "https://legalprevent.com";
    const successUrl = String(body.successUrl || `${siteUrl}/gracias/?origen=stripe`);
    const cancelUrl = String(body.cancelUrl || `${siteUrl}/#precios`);
    const email = String(body.email || "").trim().toLowerCase();

    const params = new URLSearchParams({
      mode: "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      success_url: successUrl,
      cancel_url: cancelUrl,
      "metadata[plan]": plan,
      "metadata[source]": "legalprevent_web",
      "subscription_data[metadata][plan]": plan,
      allow_promotion_codes: "true",
      billing_address_collection: "auto"
    });

    if (email) params.set("customer_email", email);

    const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });

    const session = await stripeResponse.json();
    if (!stripeResponse.ok) {
      return json({ error: session.error?.message || "Stripe no ha podido crear la sesión." }, 400);
    }

    await insertCheckoutSession({
      stripe_session_id: session.id,
      plan,
      price_id: priceId,
      status: session.status,
      payment_status: session.payment_status,
      customer_email: session.customer_email || email || null,
      checkout_url: session.url,
      payload: session
    });

    return json({ id: session.id, url: session.url });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Error inesperado." }, 500);
  }
});
