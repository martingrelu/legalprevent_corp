const navToggle = document.querySelector(".nav-toggle");
const nav = document.querySelector("#site-nav");

window.dataLayer = window.dataLayer || [];
function gtag() {
  window.dataLayer.push(arguments);
}

gtag("consent", "default", {
  analytics_storage: "denied",
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
  personalization_storage: "denied",
  functionality_storage: "granted",
  security_storage: "granted"
});

const ensureCookieUi = () => {
  if (document.querySelector("[data-cookie-banner]")) return;

  document.body.insertAdjacentHTML(
    "beforeend",
    `<div class="cookie-banner" data-cookie-banner role="dialog" aria-labelledby="cookie-title" aria-modal="false" hidden>
      <div>
        <strong id="cookie-title">Configuración de cookies</strong>
        <p>Utilizamos cookies técnicas necesarias y, solo con tu consentimiento, cookies analíticas, de personalización y de marketing. Puedes aceptar, rechazar o configurar tus preferencias.</p>
      </div>
      <div class="cookie-actions">
        <button class="btn btn-secondary" type="button" data-cookie-config>Configurar</button>
        <button class="btn btn-secondary" type="button" data-cookie-reject>Rechazar</button>
        <button class="btn btn-primary" type="button" data-cookie-accept>Aceptar</button>
      </div>
    </div>
    <div class="cookie-modal" data-cookie-modal hidden>
      <div class="cookie-panel" role="dialog" aria-modal="true" aria-labelledby="cookie-config-title">
        <h2 id="cookie-config-title">Preferencias de cookies</h2>
        <p>Gestiona el consentimiento por categorías. Las cookies técnicas son necesarias para que la web funcione.</p>
        <label class="toggle-row"><input type="checkbox" checked disabled /><span>Cookies técnicas</span></label>
        <label class="toggle-row"><input type="checkbox" data-cookie-category="analytics" /><span>Cookies analíticas</span></label>
        <label class="toggle-row"><input type="checkbox" data-cookie-category="personalization" /><span>Cookies de personalización</span></label>
        <label class="toggle-row"><input type="checkbox" data-cookie-category="marketing" /><span>Cookies publicitarias o de marketing</span></label>
        <div class="cookie-actions">
          <button class="btn btn-secondary" type="button" data-cookie-close>Cancelar</button>
          <button class="btn btn-primary" type="button" data-cookie-save>Guardar configuración</button>
        </div>
      </div>
    </div>`
  );
};

ensureCookieUi();

if (navToggle && nav) {
  navToggle.addEventListener("click", () => {
    const isOpen = document.body.classList.toggle("nav-open");
    navToggle.setAttribute("aria-expanded", String(isOpen));
  });

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      document.body.classList.remove("nav-open");
      navToggle.setAttribute("aria-expanded", "false");
    });
  });
}

const revealItems = document.querySelectorAll(".reveal");
const counters = document.querySelectorAll(".counter");
const consentKey = "lp_cookie_consent";
const banner = document.querySelector("[data-cookie-banner]");
const modal = document.querySelector("[data-cookie-modal]");
const year = document.querySelectorAll("[data-year]");

year.forEach((item) => {
  item.textContent = new Date().getFullYear();
});

document
  .querySelectorAll(".feature-card, .area-card, .sector-card, .impact-card, .testimonial-card")
  .forEach((item, index) => {
    item.style.transitionDelay = `${Math.min(index % 6, 5) * 55}ms`;
  });

const formatNumber = (value, suffix) => {
  if (suffix === "x") return value.toFixed(1).replace(".", ",") + suffix;
  if (suffix) return Math.round(value) + suffix;
  return Math.round(value).toString();
};

const animateCounter = (counter) => {
  if (counter.dataset.animated === "true") return;
  counter.dataset.animated = "true";

  const target = Number(counter.dataset.target || "0");
  const suffix = counter.dataset.suffix || "";
  const duration = 950;
  const start = performance.now();

  const tick = (time) => {
    const progress = Math.min((time - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    counter.textContent = formatNumber(target * eased, suffix);

    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      counter.textContent = formatNumber(target, suffix);
    }
  };

  requestAnimationFrame(tick);
};

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          entry.target.querySelectorAll(".counter").forEach(animateCounter);
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.16 }
  );

  revealItems.forEach((item) => observer.observe(item));
} else {
  revealItems.forEach((item) => item.classList.add("is-visible"));
  counters.forEach(animateCounter);
}

const loadAnalytics = () => {
  if (window.lpAnalyticsLoaded) return;
  window.lpAnalyticsLoaded = true;
  // Prepared for Google Analytics / GTM injection after consent.
  // Example: append the GA/GTM script here when measurement IDs are configured.
};

const loadMarketing = () => {
  if (window.lpMarketingLoaded) return;
  window.lpMarketingLoaded = true;
  // Prepared for advertising pixels only after marketing consent.
};

const applyConsent = (preferences) => {
  const analyticsGranted = preferences.analytics ? "granted" : "denied";
  const personalizationGranted = preferences.personalization ? "granted" : "denied";
  const marketingGranted = preferences.marketing ? "granted" : "denied";

  gtag("consent", "update", {
    analytics_storage: analyticsGranted,
    personalization_storage: personalizationGranted,
    ad_storage: marketingGranted,
    ad_user_data: marketingGranted,
    ad_personalization: marketingGranted
  });

  if (preferences.analytics) loadAnalytics();
  if (preferences.marketing) loadMarketing();
};

const saveConsent = (preferences) => {
  const value = {
    necessary: true,
    analytics: Boolean(preferences.analytics),
    personalization: Boolean(preferences.personalization),
    marketing: Boolean(preferences.marketing),
    savedAt: new Date().toISOString(),
    version: "2026-06-04"
  };

  localStorage.setItem(consentKey, JSON.stringify(value));
  applyConsent(value);
  if (banner) banner.hidden = true;
  if (modal) modal.hidden = true;
};

const getStoredConsent = () => {
  try {
    return JSON.parse(localStorage.getItem(consentKey) || "null");
  } catch {
    return null;
  }
};

const storedConsent = getStoredConsent();

if (storedConsent) {
  applyConsent(storedConsent);
} else if (banner) {
  banner.hidden = false;
}

document.querySelectorAll("[data-cookie-accept]").forEach((button) => {
  button.addEventListener("click", () =>
    saveConsent({ analytics: true, personalization: true, marketing: true })
  );
});

document.querySelectorAll("[data-cookie-reject]").forEach((button) => {
  button.addEventListener("click", () =>
    saveConsent({ analytics: false, personalization: false, marketing: false })
  );
});

document.querySelectorAll("[data-cookie-config]").forEach((button) => {
  button.addEventListener("click", () => {
    const current = getStoredConsent() || { analytics: false, marketing: false };
    document.querySelectorAll("[data-cookie-category='analytics']").forEach((input) => {
      input.checked = Boolean(current.analytics);
    });
    document.querySelectorAll("[data-cookie-category='marketing']").forEach((input) => {
      input.checked = Boolean(current.marketing);
    });
    document.querySelectorAll("[data-cookie-category='personalization']").forEach((input) => {
      input.checked = Boolean(current.personalization);
    });
    if (banner) banner.hidden = true;
    if (modal) modal.hidden = false;
  });
});

document.querySelectorAll("[data-cookie-close]").forEach((button) => {
  button.addEventListener("click", () => {
    if (modal) modal.hidden = true;
    if (!getStoredConsent() && banner) banner.hidden = false;
  });
});

document.querySelectorAll("[data-cookie-save]").forEach((button) => {
  button.addEventListener("click", () => {
    const analytics = document.querySelector("[data-cookie-category='analytics']")?.checked;
    const personalization = document.querySelector("[data-cookie-category='personalization']")?.checked;
    const marketing = document.querySelector("[data-cookie-category='marketing']")?.checked;
    saveConsent({ analytics, personalization, marketing });
  });
});

const createCrmId = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const getEmailCompany = (email) => {
  const domain = String(email || "").split("@")[1]?.split(".")[0] || "empresa";
  return domain.charAt(0).toUpperCase() + domain.slice(1);
};

const loadCrmState = () => {
  try {
    return JSON.parse(localStorage.getItem("legalprevent-crm-v1") || "null");
  } catch {
    return null;
  }
};

const saveDemoLeadToCrm = (payload) => {
  const now = new Date().toISOString();
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const email = String(payload.email || "").trim().toLowerCase();
  const leadId = createCrmId("lead");
  const userId = "u-1";

  const crmState = loadCrmState() || {
    currentUserId: userId,
    users: [{ id: userId, name: "Legal Prevent", email: "legal@legalprevent.com", role: "admin" }],
    leads: [],
    clients: [],
    tasks: [],
    interactions: [],
    proposals: [],
    documents: [],
    payments: [],
    activityLog: [],
    alerts: [],
    meta: { seededAt: now, version: 1 }
  };

  crmState.leads = crmState.leads || [];
  crmState.tasks = crmState.tasks || [];
  crmState.interactions = crmState.interactions || [];
  crmState.activityLog = crmState.activityLog || [];

  const existingIndex = crmState.leads.findIndex((lead) => String(lead.email || "").toLowerCase() === email);
  const existingLead = crmState.leads[existingIndex];
  const nextLead = {
    id: existingLead?.id || leadId,
    companyName: existingLead?.companyName || `Lead web - ${getEmailCompany(email)}`,
    contactName: existingLead?.contactName || "Pendiente de completar",
    email,
    phone: existingLead?.phone || "",
    sector: existingLead?.sector || "Pendiente",
    employees: existingLead?.employees || "",
    city: existingLead?.city || "",
    source: "Web",
    status: "Demo agendada",
    priority: "Alta",
    createdAt: existingLead?.createdAt || now,
    lastInteractionAt: now,
    nextActionAt: tomorrow,
    nextAction: "Contactar para agendar demostración.",
    notes: [
      existingLead?.notes,
      `Solicitud de demostración enviada desde la web el ${new Date(now).toLocaleString("es-ES")}.`,
      payload.commercial ? "Acepta comunicaciones comerciales." : "No acepta comunicaciones comerciales."
    ]
      .filter(Boolean)
      .join("\n"),
    ownerId: existingLead?.ownerId || crmState.currentUserId || userId,
    recommendedPlan: existingLead?.recommendedPlan || "Pro",
    estimatedMonthlyRevenue: existingLead?.estimatedMonthlyRevenue || 79,
    riskScore: existingLead?.riskScore || 65,
    convertedClientId: existingLead?.convertedClientId || ""
  };

  if (existingIndex >= 0) {
    crmState.leads[existingIndex] = { ...existingLead, ...nextLead };
  } else {
    crmState.leads.unshift(nextLead);
  }

  crmState.interactions.unshift({
    id: createCrmId("int"),
    type: "Demo",
    relatedType: "lead",
    relatedId: nextLead.id,
    description: "Solicitud de demostración captada desde la web corporativa.",
    date: now,
    createdBy: nextLead.ownerId
  });

  crmState.tasks.unshift({
    id: createCrmId("task"),
    title: `Contactar a ${nextLead.companyName}`,
    description: "Lead captado desde el CTA final de la web. Confirmar datos y agendar demo.",
    relatedType: "lead",
    relatedId: nextLead.id,
    dueDate: tomorrow,
    priority: "Alta",
    status: "Pendiente",
    ownerId: nextLead.ownerId
  });

  crmState.activityLog.unshift({
    id: createCrmId("log"),
    entityType: "lead",
    entityId: nextLead.id,
    action: "web_demo_requested",
    detail: "Solicitud de demostración guardada en CRM desde la web.",
    createdAt: now,
    createdBy: nextLead.ownerId
  });

  localStorage.setItem("legalprevent-crm-v1", JSON.stringify(crmState));
  sessionStorage.setItem("lp_last_crm_lead_id", nextLead.id);
  return nextLead;
};

document.querySelectorAll("form[data-form]").forEach((form) => {
  form.addEventListener("submit", (event) => {
    event.preventDefault();

    if (!form.reportValidity()) return;

    const payload = Object.fromEntries(new FormData(form).entries());
    payload.formType = form.dataset.form;
    payload.createdAt = new Date().toISOString();
    payload.source = form.dataset.form === "diagnostico" ? "landing_diagnostic_cta" : "landing_demo_cta";
    payload.crmStatus = "ready_for_crm";
    payload.pdfStatus = "ready_for_pdf_generation";
    payload.automationStatus = "ready_for_automation";

    console.info("LEGAL PREVENT lead payload", payload);

    if (form.dataset.form === "diagnostico") {
      sessionStorage.setItem(
        "lp_diagnostic_prefill",
        JSON.stringify({
          ...payload,
          leadStage: "prequalified_from_landing",
          nextStep: "diagnostic_questionnaire"
        })
      );

      const feedback = form.querySelector(".form-feedback");
      if (feedback) feedback.textContent = "Perfecto. Abriendo diagnóstico con tus datos preparados...";

      window.setTimeout(() => {
        window.location.href = "./diagnostico/?source=landing";
      }, 450);
      return;
    }

    const crmLead = saveDemoLeadToCrm(payload);
    console.info("LEGAL PREVENT CRM demo lead saved", crmLead);

    const feedback = form.querySelector(".form-feedback");
    if (feedback) {
      feedback.textContent = "Solicitud recibida. Te llevamos a la confirmación...";
    }
    window.setTimeout(() => {
      window.location.href = "./gracias/?origen=demo";
    }, 650);
  });
});
