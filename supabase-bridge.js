(function () {
  const config = window.LEGAL_PREVENT_SUPABASE || {};
  // Versiones anteriores guardaban aquí, en el navegador del visitante, los
  // datos personales de los formularios que fallaban. Nadie leía esa cola: se
  // elimina al cargar la página y ya no se escribe.
  const legacyPendingKey = "lp_pending_supabase_leads";
  const sessionKey = "lp_supabase_session";

  const cleanBaseUrl = () => String(config.url || "").trim().replace(/\/$/, "");
  const anonKey = () => String(config.anonKey || "").trim();
  const isConfigured = () => Boolean(cleanBaseUrl() && anonKey());

  const headers = (accessToken = "") => ({
    apikey: anonKey(),
    Authorization: `Bearer ${accessToken || anonKey()}`,
    "Content-Type": "application/json"
  });

  try {
    localStorage.removeItem(legacyPendingKey);
  } catch {
    // Almacenamiento no disponible (modo privado, bloqueado...): nada que limpiar.
  }

  const request = async (path, options = {}) => {
    if (!isConfigured()) throw new Error("Supabase no está configurado.");

    const response = await fetch(`${cleanBaseUrl()}${path}`, {
      ...options,
      headers: {
        ...headers(options.accessToken),
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || `Supabase respondió con estado ${response.status}.`);
    }

    if (response.status === 204) return null;
    return response.json();
  };

  // Versiones de los textos que ve el visitante al marcar las casillas. El
  // servidor valida que existan y estén vigentes, y registra la fecha.
  const CONSENT_VERSIONS = { privacy: "2026-06-04", commercial: "2026-06-04" };

  // Un checkbox marcado llega como "on" desde FormData; los flujos que ya
  // conocen el valor pasan un booleano. Cualquier otro valor cuenta como "no".
  const isChecked = (value) => value === true || value === "on";

  // La aceptación de la política de privacidad (obligatoria) y el
  // consentimiento para comunicaciones comerciales (opcional) son
  // independientes: nunca se deduce uno del otro.
  const readConsents = (input) => {
    const form = input.form || {};
    return {
      privacyAccepted: isChecked(input.privacyAccepted) || isChecked(form.privacy),
      commercialConsent: isChecked(input.commercialConsent) || isChecked(form.commercial)
    };
  };

  const buildLeadRecord = (input) => {
    const form = input.form || {};
    const lead = input.lead || {};
    const consents = readConsents(input);
    return {
      source: input.eventType || form.source || "web",
      stage: input.leadStage || "new",
      company_name: lead.companyName || form.company || "",
      contact_name: lead.contactName || form.contactName || "",
      email: lead.email || form.email || "",
      phone: lead.phone || form.phone || "",
      sector: lead.sector || form.sector || "",
      employees: Number(lead.employees || form.employees || 0) || null,
      status: lead.status || "Nuevo",
      priority: lead.priority || "Media",
      score: input.payload?.result?.globalScore ?? input.score ?? null,
      risk_score: lead.riskScore ?? null,
      recommended_plan: lead.recommendedPlan || "",
      commercial_consent: consents.commercialConsent,
      privacy_accepted: consents.privacyAccepted,
      privacy_policy_version: CONSENT_VERSIONS.privacy,
      ...(consents.commercialConsent ? { commercial_consent_version: CONSENT_VERSIONS.commercial } : {}),
      page_url: input.page || window.location.href,
      payload: input,
      created_at: new Date().toISOString()
    };
  };

  // Pide el aviso interno de un lead ya guardado. Solo viaja su id: la Edge
  // Function lee los datos del CRM y únicamente escribe al buzón interno.
  const sendLeadEmail = async (leadId, kind = "new_lead") => {
    if (!isConfigured() || !leadId) return { ok: false, configured: isConfigured() };

    try {
      const response = await fetch(`${cleanBaseUrl()}/functions/v1/smooth-action`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ leadId, kind })
      });

      if (!response.ok) throw new Error(`Aviso interno respondió con estado ${response.status}.`);
      return { ok: true, result: await response.json() };
    } catch (error) {
      console.warn("No se pudo enviar el aviso interno del lead", error);
      return { ok: false, error };
    }
  };

  const createCheckoutSession = async (input) => {
    if (!isConfigured()) throw new Error("Supabase no está configurado.");

    const response = await fetch(`${cleanBaseUrl()}/functions/v1/super-api`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        plan: input.plan,
        email: input.email || "",
        successUrl: input.successUrl || `${window.location.origin}/gracias/?origen=stripe`,
        cancelUrl: input.cancelUrl || `${window.location.origin}/#precios`,
        page: input.page || window.location.href
      })
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.url) {
      throw new Error(result.error || `Stripe respondió con estado ${response.status}.`);
    }

    return result;
  };

  const createLead = async (input) => {
    const record = buildLeadRecord(input);
    // Sin aceptación de la política de privacidad no se envía ningún dato
    // (el servidor también lo rechaza).
    if (!record.privacy_accepted) {
      return { ok: false, configured: isConfigured(), reason: "privacy_required" };
    }
    if (!isConfigured()) {
      return { ok: false, configured: false, record };
    }

    try {
      const row = await request("/rest/v1/rpc/submit_lead", {
        method: "POST",
        body: JSON.stringify({ p_payload: record })
      });
      // Demasiadas altas en poco tiempo: el servidor no guarda nada.
      if (row?.error === "rate_limited") {
        return { ok: false, configured: true, reason: "rate_limited" };
      }
      const savedRecord = { ...record, id: row?.id };
      const email = await sendLeadEmail(savedRecord.id);
      return { ok: true, configured: true, record: savedRecord, email };
    } catch (error) {
      console.warn("No se pudo enviar el lead a Supabase", error);
      return { ok: false, configured: true, record, error };
    }
  };

  const createDiagnostic = async (input) => {
    const payload = input.payload || {};
    const record = {
      company_name: payload.company?.company || "",
      email: payload.company?.email || "",
      phone: payload.company?.phone || "",
      sector: payload.company?.sector || "",
      employees: payload.company?.employees || "",
      score: payload.result?.globalScore ?? null,
      classification: payload.result?.classification?.label || "",
      critical_areas: payload.result?.criticalAreas || [],
      priorities: payload.result?.priorities || [],
      risks: payload.result?.risks || [],
      privacy_accepted: readConsents(input).privacyAccepted,
      privacy_policy_version: CONSENT_VERSIONS.privacy,
      payload: input,
      created_at: new Date().toISOString()
    };

    if (!record.privacy_accepted) {
      return { ok: false, configured: isConfigured(), reason: "privacy_required" };
    }
    if (!isConfigured()) {
      return { ok: false, configured: false, record };
    }

    try {
      const row = await request("/rest/v1/rpc/submit_diagnostic", {
        method: "POST",
        body: JSON.stringify({ p_payload: record })
      });
      if (row?.error === "rate_limited") {
        return { ok: false, configured: true, reason: "rate_limited" };
      }
      return { ok: true, configured: true, record: { ...record, id: row?.id } };
    } catch (error) {
      console.warn("No se pudo enviar el diagnóstico a Supabase", error);
      return { ok: false, configured: true, record, error };
    }
  };

  // Registra que el visitante pide una demostración tras su diagnóstico, sobre
  // el mismo lead (sin crear otro) y avisa al buzón interno.
  const requestLeadDemo = async (leadId) => {
    if (!isConfigured() || !leadId) return { ok: false };

    try {
      const marked = await request("/rest/v1/rpc/request_lead_demo", {
        method: "POST",
        body: JSON.stringify({ p_lead_id: leadId })
      });
      if (marked !== true) return { ok: false };
      const email = await sendLeadEmail(leadId, "demo_request");
      return { ok: true, email };
    } catch (error) {
      console.warn("No se pudo registrar la solicitud de demostración", error);
      return { ok: false, error };
    }
  };

  const signIn = async (email, password) => {
    const session = await request("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    sessionStorage.setItem(sessionKey, JSON.stringify(session));
    return session;
  };

  const getSession = () => {
    try {
      return JSON.parse(sessionStorage.getItem(sessionKey) || "null");
    } catch {
      return null;
    }
  };

  const signOut = () => {
    sessionStorage.removeItem(sessionKey);
  };

  const fetchLeads = async () => {
    const session = getSession();
    if (!session?.access_token) throw new Error("Inicia sesión para ver leads centrales.");
    return request("/rest/v1/leads?select=*&order=created_at.desc", {
      method: "GET",
      accessToken: session.access_token
    });
  };

  // Claves que el CRM gestiona dentro de leads.payload. El resto del payload
  // (formulario, diagnóstico web...) pertenece al origen del lead y no se toca.
  const buildCrmPayload = (lead) => ({
    city: lead.city || "",
    nextAction: lead.nextAction || "",
    notes: lead.notes || "",
    ownerId: lead.ownerId || "",
    estimatedMonthlyRevenue: Number(lead.estimatedMonthlyRevenue || 0),
    revenueConfirmed: lead.revenueConfirmed === true
  });

  // stage y page_url describen el punto de entrada del lead: solo se escriben
  // al crearlo, nunca al editarlo desde el CRM.
  const buildCrmLeadRecord = (lead) => ({
    source: lead.source || "CRM manual",
    company_name: lead.companyName || "",
    contact_name: lead.contactName || "",
    email: String(lead.email || "").trim().toLowerCase(),
    phone: lead.phone || "",
    sector: lead.sector || "",
    employees: Number(lead.employees || 0) || null,
    status: lead.status || "Nuevo",
    priority: lead.priority || "Media",
    risk_score: Number(lead.riskScore || 0),
    recommended_plan: lead.recommendedPlan || "",
    lead_type: lead.leadType || null,
    zone: lead.zone || null,
    demo_at: lead.demoAt || null,
    next_action_at: lead.nextActionAt || null,
    lost_reason: lead.lostReason || null
  });

  const saveCrmLead = async (lead) => {
    const session = getSession();
    if (!session?.access_token) throw new Error("Conecta Supabase antes de guardar un lead manual.");

    const record = buildCrmLeadRecord(lead);
    if (!record.email) throw new Error("El email del lead es obligatorio.");

    const lookup = lead.supabaseId
      ? `id=eq.${encodeURIComponent(lead.supabaseId)}`
      : `email=eq.${encodeURIComponent(record.email)}`;
    const existing = await request(`/rest/v1/leads?select=id,payload,stage&${lookup}&limit=1`, {
      method: "GET",
      accessToken: session.access_token
    });
    const current = existing?.[0];

    if (current) {
      // La fuente de un lead web es su canal de entrada: no se modifica desde el CRM.
      const isManual = current.payload?.origin === "crm_manual" || current.stage === "crm_manual";
      if (!isManual) delete record.source;
      const payload = { ...(current.payload || {}), ...buildCrmPayload(lead) };
      // nextActionAt vive ahora en la columna next_action_at; se retira del payload
      // para que el respaldo antiguo no resucite una fecha borrada.
      delete payload.nextActionAt;
      const rows = await request(`/rest/v1/leads?id=eq.${encodeURIComponent(current.id)}`, {
        method: "PATCH",
        accessToken: session.access_token,
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ ...record, payload })
      });
      return rows?.[0] || { id: current.id, ...record, payload };
    }

    const created = {
      ...record,
      stage: "crm_manual",
      page_url: window.location.href,
      payload: { origin: "crm_manual", ...buildCrmPayload(lead) }
    };
    const rows = await request("/rest/v1/leads", {
      method: "POST",
      accessToken: session.access_token,
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(created)
    });
    return rows?.[0] || created;
  };

  const fetchBillingData = async () => {
    const session = getSession();
    if (!session?.access_token) throw new Error("Inicia sesión para ver datos de contratación.");

    const [checkoutSessions, subscriptions, payments] = await Promise.all([
      request("/rest/v1/checkout_sessions?select=*&order=created_at.desc", {
        method: "GET",
        accessToken: session.access_token
      }),
      request("/rest/v1/subscriptions?select=*&order=created_at.desc", {
        method: "GET",
        accessToken: session.access_token
      }),
      request("/rest/v1/payments?select=*&order=created_at.desc", {
        method: "GET",
        accessToken: session.access_token
      })
    ]);

    return {
      checkoutSessions: checkoutSessions || [],
      subscriptions: subscriptions || [],
      payments: payments || []
    };
  };

  window.LegalPreventSupabase = {
    isConfigured,
    createLead,
    createDiagnostic,
    requestLeadDemo,
    createCheckoutSession,
    sendLeadEmail,
    signIn,
    signOut,
    getSession,
    fetchLeads,
    fetchBillingData,
    saveCrmLead
  };
})();
