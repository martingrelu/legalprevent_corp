// Escudito, el asistente comercial de LegalPrevent (PR2f).
//
// Widget de la portada y de /partner/ (nunca en /diagnostico/). Doble cierre
// antes del lanzamiento:
//   1. PUBLIC_LAUNCHER = false: el botón no aparece a ningún visitante y no se
//      hace ninguna llamada.
//   2. Vista previa con #agente-preview: el widget aparece y habla con
//      sales-agent. Si en esta pestaña hay sesión de administrador del CRM, la
//      función la trata como laboratorio privado; si no, como visitante, y con
//      public_enabled=false responde 403 (el widget muestra el estado de error).
//      El cierre real lo pone el servidor, no el navegador.
//
// Privacidad: la conversación y el estado firmado viven solo en memoria de la
// pestaña. Nada se escribe en localStorage, sessionStorage, cookies ni
// IndexedDB. La vista previa solo LEE la sesión que el CRM ya guarda.
// Sin seguimiento ni identificadores nuevos.
(function (root, factory) {
  const api = factory();
  root.LegalPreventAgentWidget = api;
  if (root.document) api.boot(root);
})(typeof window !== "undefined" ? window : globalThis, function () {
  const PUBLIC_LAUNCHER = true;
  const PREVIEW_HASH = "#agente-preview";
  // Modelo para la vista previa con sesión de administrador (en modo público lo
  // decide siempre el servidor y este valor se ignora).
  const PREVIEW_MODEL = "gpt-6-luna";
  const SESSION_KEY = "lp_supabase_session";
  const ASSET_VERSION = "20261002-2";
  const MAX_CHARS = 1000;
  const TIMEOUT_MS = 25000;
  const PAGES = new Set(["/", "/index.html", "/partner/", "/partner/index.html"]);
  const CONTACT_EMAIL = "legal@legalprevent.com";

  const TEXT = {
    title: "Escudito",
    subtitle: "Asistente de LegalPrevent · IA",
    open: "Abrir Escudito, el asistente virtual de LegalPrevent (IA)",
    hint: "¿Tienes dudas? Pregúntame",
    close: "Cerrar el asistente",
    greeting: "¡Hola! Soy Escudito, el asistente virtual de LegalPrevent. Puedo explicarte nuestros planes, el diagnóstico gratuito y el programa Partner. ¿En qué te ayudo?",
    questions: [
      "¿Cuánto cuesta LegalPrevent?",
      "¿Qué incluye el diagnóstico gratuito?",
      "Soy gestoría o asesoría, ¿qué me ofrecéis?",
    ],
    notice: "Soy un asistente de IA. Para proteger tu privacidad, no incluyas datos personales como nombre, email, teléfono o DNI. Puedo ofrecerte información general sobre LegalPrevent, pero no asesoramiento jurídico individualizado.",
    privacy: "Política de privacidad",
    footer: "Respuestas generadas por IA a partir de la información de LegalPrevent. Para cuestiones específicas, puedes hablar con nuestro equipo.",
    human: "¿Prefieres hablar con una persona?",
    humanLink: "Déjanos tus datos",
    placeholder: "Escribe tu pregunta…",
    waiting: "Espera la respuesta…",
    input: "Tu pregunta",
    send: "Enviar",
    typing: "Escudito está escribiendo…",
    you: "Tú",
    error: `Ahora mismo no puedo responder. Inténtalo de nuevo en unos minutos o escríbenos a ${CONTACT_EMAIL}.`,
    retry: "Reintentar",
    contact: "Dejar mis datos de contacto",
    preview: "Vista previa",
  };

  const ACTION_ID = /^(link:(diagnostico|precios|partner|comprar:[a-z]+)|form:(demo|contacto|partner)|handoff)$/;

  // Solo destinos de LegalPrevent y de contratación (lista cerrada, PR2d).
  function isAllowedUrl(value) {
    let url;
    try {
      url = new URL(String(value));
    } catch {
      return false;
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    if (url.hostname === "legalprevent.com" || url.hostname === "www.legalprevent.com") return true;
    return url.hostname === "legalprevent.legal" && url.pathname === "/comprar" && /^\?plan=[a-z]+$/.test(url.search) && !url.hash;
  }

  // Acción del servidor → qué pinta el widget. Cualquier otra cosa se descarta.
  function actionView(action) {
    if (!action || typeof action.id !== "string" || !ACTION_ID.test(action.id)) return null;
    const label = typeof action.label === "string" ? action.label.trim().slice(0, 60) : "";
    if (!label) return null;
    if (action.id.startsWith("link:")) return isAllowedUrl(action.url) ? { label, href: String(action.url), contact: false } : null;
    return { label, href: "/#contacto", contact: true };
  }

  function pagePath(pathname) {
    return PAGES.has(pathname) ? pathname.replace(/index\.html$/, "") : null;
  }

  function shouldActivate({ pathname, hash, launcher = PUBLIC_LAUNCHER }) {
    if (!pagePath(pathname)) return false;
    return launcher === true || hash === PREVIEW_HASH;
  }

  // Vista previa: lee (sin escribir) la sesión del CRM de esta pestaña.
  function previewToken(storage) {
    try {
      const session = JSON.parse(storage.getItem(SESSION_KEY) || "null");
      return session && typeof session.access_token === "string" ? session.access_token : null;
    } catch {
      return null;
    }
  }

  function mascot(size, state) {
    return `<svg class="lpa-mascot${state ? ` is-${state}` : ""}" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">`
      + '<path d="M32 4c6 3.6 13.6 5.4 21 5.6 1.4 0 2.5 1.1 2.5 2.5V30c0 13-9.6 23.2-22.6 28.2-.6.2-1.2.2-1.8 0C18.1 53.2 8.5 43 8.5 30V12.1c0-1.4 1.1-2.5 2.5-2.5C18.4 9.4 26 7.6 32 4z" fill="#1e5eff"/>'
      + '<rect x="15.5" y="18" width="33" height="21" rx="10.5" fill="#fff"/>'
      + '<circle class="lpa-eye" cx="25" cy="27.5" r="3.4" fill="#0f172a"/>'
      + '<circle class="lpa-eye" cx="39" cy="27.5" r="3.4" fill="#0f172a"/>'
      + '<path class="lpa-smile" d="M27.5 33.2c2.6 2 6.4 2 9 0" stroke="#0f172a" stroke-width="2.4" stroke-linecap="round" fill="none"/>'
      + '<circle class="lpa-seal" cx="47" cy="47" r="8.5" fill="#13b981" stroke="#fff" stroke-width="2.5"/>'
      + '<path d="M43.2 47.2l2.6 2.6 5-5.2" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'
      + "</svg>";
  }

  function boot(win) {
    const doc = win.document;
    const script = doc.currentScript;
    const assetBase = script && script.src ? new URL(".", script.src).href : new URL("/", win.location.href).href;
    let started = false;

    const tryStart = () => {
      if (started || !shouldActivate({ pathname: win.location.pathname, hash: win.location.hash })) return;
      started = true;
      start(win, assetBase, win.location.hash === PREVIEW_HASH);
    };
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", tryStart);
    else tryStart();
    win.addEventListener("hashchange", tryStart);
  }

  function loadScript(doc, src) {
    return new Promise((resolve, reject) => {
      const tag = doc.createElement("script");
      tag.src = src;
      tag.onload = resolve;
      tag.onerror = reject;
      doc.head.appendChild(tag);
    });
  }

  function start(win, assetBase, preview) {
    const doc = win.document;
    const css = doc.createElement("link");
    css.rel = "stylesheet";
    css.href = `${assetBase}agent-widget.css?v=${ASSET_VERSION}`;
    doc.head.appendChild(css);

    const config = () => win.LEGAL_PREVENT_SUPABASE && win.LEGAL_PREVENT_SUPABASE.url ? win.LEGAL_PREVENT_SUPABASE : null;
    const configReady = config()
      ? Promise.resolve()
      : loadScript(doc, `${assetBase}supabase-config.js?v=${ASSET_VERSION}`).catch(() => undefined);

    const el = (tag, props = {}, children = []) => {
      const node = doc.createElement(tag);
      for (const [key, value] of Object.entries(props)) {
        if (key === "text") node.textContent = value;
        else if (key === "class") node.className = value;
        else node.setAttribute(key, value);
      }
      for (const child of children) node.append(child);
      return node;
    };

    // ---- Estructura ----
    const rootEl = el("div", { id: "lp-agent", class: "lpa" });
    const launcher = el("button", { type: "button", class: "lpa-launcher", "aria-label": TEXT.open, "aria-expanded": "false", "aria-controls": "lpa-panel" });
    launcher.innerHTML = mascot(44);
    launcher.append(el("span", { class: "lpa-hint", "aria-hidden": "true", text: TEXT.hint }));

    const panel = el("div", { id: "lpa-panel", class: "lpa-panel", role: "dialog", "aria-labelledby": "lpa-title", "aria-describedby": "lpa-notice", hidden: "" });
    const avatar = el("div", { class: "lpa-avatar" });
    avatar.innerHTML = mascot(32);
    const closeBtn = el("button", { type: "button", class: "lpa-close", "aria-label": TEXT.close });
    closeBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
    const header = el("div", { class: "lpa-header" }, [
      avatar,
      el("div", { class: "lpa-heading" }, [
        el("h2", { id: "lpa-title", text: TEXT.title }),
        el("span", { text: preview ? `${TEXT.subtitle} · ${TEXT.preview}` : TEXT.subtitle }),
      ]),
      closeBtn,
    ]);
    const privacyLink = el("a", { href: "/politica-privacidad/", text: TEXT.privacy });
    const notice = el("p", { id: "lpa-notice", class: "lpa-notice" }, [`${TEXT.notice} `, privacyLink]);

    const log = el("div", { class: "lpa-log", role: "log", "aria-live": "polite", "aria-relevant": "additions", tabindex: "0", "aria-label": "Conversación con Escudito" });
    const status = el("p", { class: "lpa-status", role: "status", "aria-live": "polite" });
    const human = el("p", { class: "lpa-human" }, [`${TEXT.human} `, el("a", { href: "/#contacto", "data-lpa-contact": "", text: TEXT.humanLink })]);

    const input = el("textarea", { class: "lpa-input", rows: "1", maxlength: String(MAX_CHARS), placeholder: TEXT.placeholder, "aria-label": TEXT.input, "aria-describedby": "lpa-count" });
    const sendBtn = el("button", { type: "submit", class: "lpa-send", "aria-label": TEXT.send });
    sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 12l15-7-5 15-2.5-6.5z" fill="currentColor"/></svg>';
    const count = el("span", { id: "lpa-count", class: "lpa-count", text: `0/${MAX_CHARS}` });
    const form = el("form", { class: "lpa-composer" }, [
      el("div", { class: "lpa-row" }, [input, sendBtn]),
      el("div", { class: "lpa-meta" }, [count, el("span", { text: TEXT.footer })]),
    ]);

    panel.append(header, notice, log, status, human, form);
    rootEl.append(launcher, panel);
    doc.body.appendChild(rootEl);

    // ---- Estado en memoria ----
    let signedState = null;
    let busy = false;
    let lastFailed = null;

    const scrollToEnd = () => { log.scrollTop = log.scrollHeight; };
    const who = (name, state) => {
      const node = el("div", { class: "lpa-who" });
      node.innerHTML = mascot(24, state);
      node.append(name);
      return node;
    };
    const addBot = (text, actions = [], opts = {}) => {
      const wrap = el("div", { class: "lpa-turn lpa-turn-bot" }, [who(TEXT.title, opts.error ? "error" : ""), el("p", { class: `lpa-msg lpa-bot${opts.error ? " lpa-err" : ""}`, text })]);
      const views = actions.map(actionView).filter(Boolean).slice(0, 4);
      if (views.length) {
        wrap.append(el("div", { class: "lpa-actions" }, views.map((view, i) => {
          const link = el("a", { class: `lpa-chip${i === 0 ? " is-primary" : ""}`, href: view.href, text: view.label });
          if (view.contact) link.setAttribute("data-lpa-contact", "");
          else if (/^https:\/\/legalprevent\.legal\//.test(view.href)) link.rel = "noopener";
          return link;
        })));
      }
      if (opts.retry) {
        const retry = el("button", { type: "button", class: "lpa-chip is-primary", text: TEXT.retry });
        retry.addEventListener("click", () => { if (lastFailed) send(lastFailed); });
        const contact = el("a", { class: "lpa-chip", href: "/#contacto", "data-lpa-contact": "", text: TEXT.contact });
        wrap.append(el("div", { class: "lpa-actions" }, [retry, contact]));
      }
      log.append(wrap);
      scrollToEnd();
    };
    const addMe = (text) => {
      log.append(el("div", { class: "lpa-turn lpa-turn-me" }, [el("span", { class: "lpa-sr", text: `${TEXT.you}: ` }), el("p", { class: "lpa-msg lpa-me", text })]));
      scrollToEnd();
    };

    const suggestions = el("div", { class: "lpa-suggestions" }, TEXT.questions.map((question) => {
      const button = el("button", { type: "button", class: "lpa-suggestion", text: question });
      button.addEventListener("click", () => send(question));
      return button;
    }));
    addBot(TEXT.greeting);
    log.append(suggestions);

    const setBusy = (value) => {
      busy = value;
      input.disabled = value;
      sendBtn.disabled = value;
      input.placeholder = value ? TEXT.waiting : TEXT.placeholder;
      log.setAttribute("aria-busy", value ? "true" : "false");
      avatar.innerHTML = mascot(32, value ? "thinking" : "");
      let typing = log.querySelector(".lpa-typing");
      if (value && !typing) {
        typing = el("div", { class: "lpa-turn lpa-turn-bot lpa-typing", "aria-hidden": "true" }, [who(TEXT.title, "thinking"), el("p", { class: "lpa-msg lpa-bot" }, [el("span", { class: "lpa-dots" }, [el("i"), el("i"), el("i")])])]);
        log.append(typing);
        scrollToEnd();
      } else if (!value && typing) typing.remove();
      status.textContent = value ? TEXT.typing : "";
    };

    async function send(message) {
      const text = String(message || "").trim().slice(0, MAX_CHARS);
      if (!text || busy) return;
      if (suggestions.isConnected) suggestions.remove();
      if (lastFailed !== text) addMe(text);
      lastFailed = null;
      input.value = "";
      updateCount();
      setBusy(true);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        await configReady;
        const cfg = config();
        if (!cfg) throw new Error("config");
        const token = preview ? previewToken(win.sessionStorage) : null;
        const body = { message: text, page: pagePath(win.location.pathname) };
        if (signedState) body.state = signedState;
        if (token) body.model = PREVIEW_MODEL;
        const response = await win.fetch(`${cfg.url.replace(/\/+$/, "")}/functions/v1/sales-agent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: cfg.anonKey, Authorization: `Bearer ${token || cfg.anonKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const data = response.ok ? await response.json() : null;
        if (!data || typeof data.reply !== "string" || !data.reply.trim()) throw new Error(`http_${response.status}`);
        if (typeof data.state === "string") signedState = data.state;
        setBusy(false);
        addBot(data.reply, Array.isArray(data.actions) ? data.actions : []);
      } catch {
        lastFailed = text;
        setBusy(false);
        addBot(TEXT.error, [], { error: true, retry: true });
      } finally {
        clearTimeout(timer);
        if (isOpen()) input.focus();
      }
    }

    // ---- Apertura, cierre y teclado ----
    const small = win.matchMedia("(max-width: 639px)");
    const isOpen = () => !panel.hidden;
    const focusables = () => [...panel.querySelectorAll("a[href], button:not([disabled]), textarea:not([disabled]), [tabindex='0']")].filter((node) => node.offsetParent !== null);

    function open() {
      panel.hidden = false;
      launcher.setAttribute("aria-expanded", "true");
      rootEl.classList.add("is-open");
      panel.setAttribute("aria-modal", small.matches ? "true" : "false");
      doc.documentElement.classList.toggle("lpa-lock", small.matches);
      input.focus();
    }
    function close() {
      panel.hidden = true;
      launcher.setAttribute("aria-expanded", "false");
      rootEl.classList.remove("is-open");
      doc.documentElement.classList.remove("lpa-lock");
      launcher.focus();
    }

    launcher.addEventListener("click", () => (isOpen() ? close() : open()));
    closeBtn.addEventListener("click", close);
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "Tab" && small.matches) {
        // A pantalla completa el panel es modal: el foco no sale de él.
        const items = focusables();
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    small.addEventListener("change", () => {
      if (!isOpen()) return;
      panel.setAttribute("aria-modal", small.matches ? "true" : "false");
      doc.documentElement.classList.toggle("lpa-lock", small.matches);
    });

    // Las acciones de contacto llevan al formulario existente (con sus
    // consentimientos). Nunca se rellena nada con texto de la conversación.
    panel.addEventListener("click", (event) => {
      const link = event.target.closest("a[data-lpa-contact]");
      if (!link) return;
      const target = doc.getElementById("contacto");
      if (!target) return;
      event.preventDefault();
      close();
      target.scrollIntoView({ behavior: win.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      const field = target.querySelector("input, textarea, select");
      if (field) field.focus({ preventScroll: true });
    });

    function updateCount() { count.textContent = `${input.value.length}/${MAX_CHARS}`; }
    input.addEventListener("input", updateCount);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      send(input.value);
    });

    // El botón no se superpone al aviso de cookies: se oculta mientras está visible.
    const syncCookieBanner = () => {
      const banner = doc.querySelector("[data-cookie-banner]");
      rootEl.classList.toggle("is-behind-cookies", Boolean(banner && !banner.hidden));
    };
    syncCookieBanner();
    new win.MutationObserver(syncCookieBanner).observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
  }

  return { PUBLIC_LAUNCHER, PREVIEW_HASH, PREVIEW_MODEL, TEXT, isAllowedUrl, actionView, pagePath, shouldActivate, previewToken, mascot, boot };
});
