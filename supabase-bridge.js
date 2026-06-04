(function () {
  const config = window.LEGAL_PREVENT_SUPABASE || {};
  const pendingKey = "lp_pending_supabase_leads";
  const sessionKey = "lp_supabase_session";

  const cleanBaseUrl = () => String(config.url || "").trim().replace(/\/$/, "");
  const anonKey = () => String(config.anonKey || "").trim();
  const isConfigured = () => Boolean(cleanBaseUrl() && anonKey());

  const createId = (prefix) =>
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  const headers = (accessToken = "") => ({
    apikey: anonKey(),
    Authorization: `Bearer ${accessToken || anonKey()}`,
    "Content-Type": "application/json"
  });

  const savePending = (payload, reason) => {
    try {
      const pending = JSON.parse(localStorage.getItem(pendingKey) || "[]");
      pending.unshift({
        id: createId("pending"),
        queuedAt: new Date().toISOString(),
        reason,
        payload
      });
      localStorage.setItem(pendingKey, JSON.stringify(pending.slice(0, 50)));
    } catch (error) {
      console.warn("No se pudo guardar el lead pendiente de Supabase", error);
    }
  };

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

  const buildLeadRecord = (input) => {
    const form = input.form || {};
    const lead = input.lead || {};
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
      commercial_consent: Boolean(form.commercial || input.commercialConsent),
      privacy_accepted: Boolean(form.privacy || input.privacyAccepted),
      page_url: input.page || window.location.href,
      payload: input,
      created_at: new Date().toISOString()
    };
  };

  const createLead = async (input) => {
    const record = buildLeadRecord(input);
    if (!isConfigured()) {
      savePending(record, "supabase_not_configured");
      return { ok: false, configured: false, record };
    }

    try {
      const row = await request("/rest/v1/rpc/submit_lead", {
        method: "POST",
        body: JSON.stringify({ p_payload: record })
      });
      return { ok: true, configured: true, record: row || record };
    } catch (error) {
      savePending(record, "supabase_insert_failed");
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
      payload: input,
      created_at: new Date().toISOString()
    };

    if (!isConfigured()) {
      savePending(record, "supabase_not_configured");
      return { ok: false, configured: false, record };
    }

    try {
      const row = await request("/rest/v1/rpc/submit_diagnostic", {
        method: "POST",
        body: JSON.stringify({ p_payload: record })
      });
      return { ok: true, configured: true, record: row || record };
    } catch (error) {
      savePending(record, "supabase_diagnostic_insert_failed");
      console.warn("No se pudo enviar el diagnóstico a Supabase", error);
      return { ok: false, configured: true, record, error };
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

  window.LegalPreventSupabase = {
    isConfigured,
    createLead,
    createDiagnostic,
    signIn,
    signOut,
    getSession,
    fetchLeads
  };
})();
