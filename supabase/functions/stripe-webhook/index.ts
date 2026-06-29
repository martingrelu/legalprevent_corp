const encoder = new TextEncoder();

const hexToBytes = (hex: string) => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const timingSafeEqual = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) result |= a[index] ^ b[index];
  return result === 0;
};

const verifyStripeSignature = async (payload: string, signatureHeader: string, secret: string) => {
  const parts = Object.fromEntries(signatureHeader.split(",").map((part) => part.split("=")));
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signedPayload = `${timestamp}.${payload}`;
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
  return timingSafeEqual(new Uint8Array(digest), hexToBytes(signature));
};

const supabaseRequest = async (path: string, body: unknown) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return;

  await fetch(`${supabaseUrl}${path}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(body)
  });
};

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!webhookSecret) return new Response("Missing webhook secret", { status: 500 });

  const signature = request.headers.get("stripe-signature") || "";
  const rawBody = await request.text();
  const valid = await verifyStripeSignature(rawBody, signature, webhookSecret);
  if (!valid) return new Response("Invalid signature", { status: 400 });

  const event = JSON.parse(rawBody);
  const object = event.data?.object || {};

  if (event.type === "checkout.session.completed") {
    await supabaseRequest("/rest/v1/checkout_sessions?on_conflict=stripe_session_id", {
      stripe_session_id: object.id,
      stripe_customer_id: object.customer,
      stripe_subscription_id: object.subscription,
      plan: object.metadata?.plan || null,
      status: object.status,
      payment_status: object.payment_status,
      customer_email: object.customer_details?.email || object.customer_email || null,
      payload: object,
      updated_at: new Date().toISOString()
    });
  }

  if (event.type?.startsWith("customer.subscription.")) {
    await supabaseRequest("/rest/v1/subscriptions?on_conflict=stripe_subscription_id", {
      stripe_subscription_id: object.id,
      stripe_customer_id: object.customer,
      plan: object.metadata?.plan || null,
      status: object.status,
      current_period_start: object.current_period_start ? new Date(object.current_period_start * 1000).toISOString() : null,
      current_period_end: object.current_period_end ? new Date(object.current_period_end * 1000).toISOString() : null,
      cancel_at_period_end: Boolean(object.cancel_at_period_end),
      payload: object,
      updated_at: new Date().toISOString()
    });
  }

  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    await supabaseRequest("/rest/v1/payments?on_conflict=stripe_invoice_id", {
      stripe_invoice_id: object.id,
      stripe_customer_id: object.customer,
      stripe_subscription_id: object.subscription,
      amount_paid: object.amount_paid || 0,
      currency: object.currency || "eur",
      status: object.status,
      hosted_invoice_url: object.hosted_invoice_url || null,
      payload: object
    });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" }
  });
});
