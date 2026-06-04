const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type LeadEmailPayload = {
  eventType?: string;
  lead?: Record<string, unknown>;
  form?: Record<string, unknown>;
  page?: string;
  payload?: Record<string, unknown>;
};

const text = (value: unknown) => String(value ?? "").trim();

const escapeHtml = (value: unknown) =>
  text(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const pick = (...values: unknown[]) => values.map(text).find(Boolean) || "";

const buildLead = (payload: LeadEmailPayload) => {
  const lead = payload.lead || {};
  const form = payload.form || {};
  const diagnosticCompany = (payload.payload?.company || {}) as Record<string, unknown>;

  return {
    company: pick(lead.company_name, lead.companyName, form.company, diagnosticCompany.company, "Empresa pendiente"),
    contact: pick(lead.contact_name, lead.contactName, form.contactName, diagnosticCompany.company, "Contacto pendiente"),
    email: pick(lead.email, form.email, diagnosticCompany.email),
    phone: pick(lead.phone, form.phone, diagnosticCompany.phone),
    sector: pick(lead.sector, form.sector, diagnosticCompany.sector),
    employees: pick(lead.employees, form.employees, diagnosticCompany.employees),
    source: pick(lead.source, payload.eventType, form.source, "web"),
    page: pick(payload.page, lead.page_url),
    score: pick(lead.score, (payload.payload?.result as Record<string, unknown> | undefined)?.globalScore),
  };
};

const sendEmail = async (message: Record<string, unknown>) => {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) throw new Error("Falta RESEND_API_KEY");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Método no permitido" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = (await request.json()) as LeadEmailPayload;
    const lead = buildLead(payload);

    if (!lead.email) {
      return new Response(JSON.stringify({ error: "Email obligatorio" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const from = Deno.env.get("FROM_EMAIL") || "Legal Prevent <onboarding@resend.dev>";
    const notifyTo = Deno.env.get("LEAD_NOTIFY_EMAIL") || "legal@legalprevent.com";
    const brandUrl = Deno.env.get("PUBLIC_SITE_URL") || "https://legalprevent.com";
    const subjectSuffix = lead.score ? ` · Score ${escapeHtml(lead.score)}` : "";

    const internalHtml = `
      <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#0f172a">
        <h1 style="margin:0 0 12px">Nuevo lead en Legal Prevent${subjectSuffix}</h1>
        <p><strong>Empresa:</strong> ${escapeHtml(lead.company)}</p>
        <p><strong>Contacto:</strong> ${escapeHtml(lead.contact)}</p>
        <p><strong>Email:</strong> ${escapeHtml(lead.email)}</p>
        <p><strong>Teléfono:</strong> ${escapeHtml(lead.phone || "No indicado")}</p>
        <p><strong>Sector:</strong> ${escapeHtml(lead.sector || "No indicado")}</p>
        <p><strong>Empleados:</strong> ${escapeHtml(lead.employees || "No indicado")}</p>
        <p><strong>Origen:</strong> ${escapeHtml(lead.source)}</p>
        <p><strong>Página:</strong> ${escapeHtml(lead.page || brandUrl)}</p>
      </div>
    `;

    const leadHtml = `
      <div style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#0f172a">
        <h1 style="margin:0 0 12px">Hemos recibido tu solicitud</h1>
        <p>Gracias por contactar con <strong>LEGAL PREVENT</strong>.</p>
        <p>Hemos recibido tu solicitud y revisaremos la información para ayudarte a prevenir riesgos legales antes de que aparezcan.</p>
        <p>Nuestro equipo contactará contigo próximamente para avanzar con la demostración o el diagnóstico.</p>
        <p style="margin-top:24px"><a href="${brandUrl}" style="color:#1e5eff;font-weight:700">legalprevent.com</a></p>
      </div>
    `;

    const [internal, confirmation] = await Promise.all([
      sendEmail({
        from,
        to: [notifyTo],
        reply_to: lead.email,
        subject: `Nuevo lead Legal Prevent: ${lead.company}${subjectSuffix}`,
        html: internalHtml,
      }),
      sendEmail({
        from,
        to: [lead.email],
        subject: "Hemos recibido tu solicitud | LEGAL PREVENT",
        html: leadHtml,
      }),
    ]);

    return new Response(JSON.stringify({ ok: true, internal, confirmation }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: text(error instanceof Error ? error.message : error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
