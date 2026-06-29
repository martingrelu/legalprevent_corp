const diagnosticApp = document.querySelector("[data-diagnostic-app]");

const diagnosticQuestions = [
  {
    area: "Laboral",
    text: "¿La empresa tiene contratos laborales actualizados y firmados por todas las partes?",
    risk: "Contratos o condiciones laborales sin trazabilidad documental."
  },
  {
    area: "Laboral",
    text: "¿Existe un registro horario fiable y accesible para inspecciones?",
    risk: "Registro horario incompleto o difícil de acreditar."
  },
  {
    area: "Laboral",
    text: "¿La documentación de prevención laboral se revisa periódicamente?",
    risk: "Falta de revisión preventiva en documentación laboral."
  },
  {
    area: "Protección de datos",
    text: "¿La empresa dispone de registro de actividades de tratamiento actualizado?",
    risk: "Tratamientos de datos no documentados o desactualizados."
  },
  {
    area: "Protección de datos",
    text: "¿Los formularios web incorporan información básica de privacidad y base jurídica?",
    risk: "Captación de datos sin información suficiente al usuario."
  },
  {
    area: "Protección de datos",
    text: "¿Existen contratos de encargo con proveedores que acceden a datos personales?",
    risk: "Proveedores con acceso a datos sin contrato adecuado."
  },
  {
    area: "Protección de datos",
    text: "¿Se han definido protocolos para brechas de seguridad?",
    risk: "Ausencia de procedimiento ante incidentes de seguridad."
  },
  {
    area: "Igualdad",
    text: "¿La empresa conoce si está obligada a disponer de plan de igualdad?",
    risk: "Obligaciones de igualdad sin evaluación interna."
  },
  {
    area: "Igualdad",
    text: "¿Existe protocolo frente al acoso sexual y por razón de sexo?",
    risk: "Falta de protocolo de acoso o canales internos claros."
  },
  {
    area: "Igualdad",
    text: "¿La empresa conserva evidencias de acciones de igualdad y diversidad?",
    risk: "Medidas de igualdad sin evidencias documentales."
  },
  {
    area: "Canal de denuncias",
    text: "¿La empresa dispone de canal interno de información si está obligada?",
    risk: "Canal de denuncias inexistente o no implantado."
  },
  {
    area: "Canal de denuncias",
    text: "¿El canal garantiza confidencialidad, trazabilidad y gestión de plazos?",
    risk: "Gestión deficiente de comunicaciones internas."
  },
  {
    area: "Canal de denuncias",
    text: "¿Hay una política interna publicada sobre el uso del canal?",
    risk: "Falta de información interna sobre el canal."
  },
  {
    area: "Compliance",
    text: "¿La empresa identifica y revisa sus principales riesgos normativos?",
    risk: "Riesgos normativos sin mapa ni revisión periódica."
  },
  {
    area: "Compliance",
    text: "¿Existen responsables asignados para las obligaciones críticas?",
    risk: "Obligaciones sin responsable interno claro."
  },
  {
    area: "Compliance",
    text: "¿Se conservan evidencias de cumplimiento y revisiones realizadas?",
    risk: "Dificultad para acreditar cumplimiento ante terceros."
  },
  {
    area: "Compliance",
    text: "¿La dirección recibe información periódica sobre riesgos y acciones pendientes?",
    risk: "Baja visibilidad directiva sobre cumplimiento."
  },
  {
    area: "Uso de dispositivos",
    text: "¿Existe política de uso de dispositivos, correo y herramientas digitales?",
    risk: "Uso de medios digitales sin reglas internas claras."
  },
  {
    area: "Uso de dispositivos",
    text: "¿Se informa a empleados sobre controles, seguridad y uso aceptable?",
    risk: "Falta de transparencia sobre controles digitales."
  },
  {
    area: "Uso de dispositivos",
    text: "¿Hay medidas de seguridad para accesos, contraseñas y bajas de usuarios?",
    risk: "Accesos digitales sin controles suficientes."
  },
  {
    area: "Uso de dispositivos",
    text: "¿Los dispositivos corporativos cuentan con inventario y responsable asignado?",
    risk: "Inventario tecnológico incompleto o sin responsable."
  }
];

const answerValues = {
  yes: 1,
  partial: 0.5,
  no: 0
};

const answerLabels = {
  yes: "Sí",
  partial: "Parcialmente",
  no: "No"
};

const state = {
  company: {},
  answers: {},
  result: null,
  source: "direct_diagnostic",
  crmLeadId: ""
};

if (diagnosticApp) {
  const questionList = document.querySelector("[data-question-list]");
  const questionCount = document.querySelector("[data-question-count]");
  const questionProgress = document.querySelector("[data-question-progress]");

  const showStep = (step) => {
    document.querySelectorAll("[data-diagnostic-step]").forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.diagnosticStep === String(step));
    });
    document.querySelectorAll("[data-step-indicator]").forEach((item) => {
      item.classList.toggle("active", item.dataset.stepIndicator === String(step));
      item.classList.toggle("complete", Number(item.dataset.stepIndicator) < Number(step));
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const updateQuestionProgress = () => {
    const answered = Object.keys(state.answers).length;
    const total = diagnosticQuestions.length;
    if (questionCount) questionCount.textContent = `${answered} de ${total} preguntas`;
    if (questionProgress) questionProgress.style.width = `${(answered / total) * 100}%`;
  };

  const renderQuestions = () => {
    if (!questionList) return;

    questionList.innerHTML = diagnosticQuestions
      .map(
        (question, index) => `
          <article class="question-card" data-question="${index}">
            <div>
              <span>${question.area}</span>
              <h3>${index + 1}. ${question.text}</h3>
            </div>
            <div class="answer-group" role="radiogroup" aria-label="${question.text}">
              ${Object.entries(answerLabels)
                .map(
                  ([value, label]) => `
                    <label>
                      <input type="radio" name="question-${index}" value="${value}" required />
                      <span>${label}</span>
                    </label>
                  `
                )
                .join("")}
            </div>
          </article>
        `
      )
      .join("");

    questionList.querySelectorAll("input[type='radio']").forEach((input) => {
      input.addEventListener("change", (event) => {
        const index = event.target.name.replace("question-", "");
        state.answers[index] = event.target.value;
        updateQuestionProgress();
      });
    });
  };

  const applyLandingPrefill = () => {
    try {
      const raw = sessionStorage.getItem("lp_diagnostic_prefill");
      if (!raw) return;

      const prefill = JSON.parse(raw);
      state.source = prefill.source || "landing_diagnostic_cta";

      ["company", "email", "phone", "employees", "sector"].forEach((name) => {
        const field = document.querySelector(`[name="${name}"]`);
        if (field && prefill[name]) field.value = prefill[name];
      });

      const privacy = document.querySelector('[name="privacy"]');
      if (privacy && prefill.privacy) privacy.checked = true;

      const commercial = document.querySelector('[name="commercial"]');
      if (commercial && prefill.commercial) commercial.checked = true;

      const heading = document.querySelector("[data-diagnostic-step='1'] .diagnostic-heading p");
      if (heading) {
        heading.textContent =
          "Hemos cargado los datos enviados desde la landing. Revisa la información y continúa al cuestionario.";
      }
    } catch (error) {
      console.warn("No se pudo aplicar el prefill del diagnóstico", error);
    }
  };

  const classifyScore = (score) => {
    if (score >= 75) {
      return {
        label: "Verde",
        tone: "green",
        summary: "Nivel de cumplimiento sólido. Conviene mantener seguimiento y evidencias."
      };
    }
    if (score >= 50) {
      return {
        label: "Amarillo",
        tone: "yellow",
        summary: "Cumplimiento parcial. Hay áreas que deberían priorizarse antes de una inspección."
      };
    }
    return {
      label: "Rojo",
      tone: "red",
      summary: "Riesgo elevado. Recomendamos actuar sobre documentación, responsables y evidencias."
    };
  };

  const calculateResult = () => {
    const areas = {};

    diagnosticQuestions.forEach((question, index) => {
      if (!areas[question.area]) {
        areas[question.area] = { total: 0, score: 0, risks: [], partials: 0, negatives: 0 };
      }

      const answer = state.answers[index];
      const value = answerValues[answer] ?? 0;
      areas[question.area].total += 1;
      areas[question.area].score += value;

      if (answer === "no") {
        areas[question.area].negatives += 1;
        areas[question.area].risks.push(question.risk);
      }
      if (answer === "partial") {
        areas[question.area].partials += 1;
        areas[question.area].risks.push(question.risk);
      }
    });

    const areaScores = Object.entries(areas).map(([area, data]) => ({
      area,
      score: Math.round((data.score / data.total) * 100),
      risks: data.risks,
      negatives: data.negatives,
      partials: data.partials
    }));

    const globalScore = Math.round(
      areaScores.reduce((sum, item) => sum + item.score, 0) / areaScores.length
    );

    const classification = classifyScore(globalScore);
    const criticalAreas = areaScores.filter((item) => item.score < 65).sort((a, b) => a.score - b.score);
    const risks = areaScores.flatMap((item) => item.risks.map((risk) => ({ area: item.area, risk })));

    state.result = {
      globalScore,
      classification,
      areaScores,
      criticalAreas,
      risks,
      priorities: buildPriorities(criticalAreas, risks)
    };

    return state.result;
  };

  const buildPriorities = (criticalAreas, risks) => {
    const priorities = [];

    if (criticalAreas[0]) priorities.push(`Priorizar ${criticalAreas[0].area} por puntuación baja.`);
    if (criticalAreas[1]) priorities.push(`Asignar responsable interno para ${criticalAreas[1].area}.`);
    if (risks.length) priorities.push("Documentar evidencias y calendario de corrección.");
    priorities.push("Programar revisión periódica y alertas de seguimiento.");

    return priorities.slice(0, 4);
  };

  const renderResult = (result) => {
    document.querySelectorAll(".diagnostic-score-ring").forEach((ring) => {
      ring.style.setProperty("--score", result.globalScore);
      ring.dataset.tone = result.classification.tone;
    });

    const scoreValue = document.querySelector("[data-score-value]");
    const scoreStatus = document.querySelector("[data-score-status]");
    const scoreSummary = document.querySelector("[data-score-summary]");
    const reportScore = document.querySelector("[data-report-score]");
    const reportClassification = document.querySelector("[data-report-classification]");

    if (scoreValue) scoreValue.textContent = result.globalScore;
    if (scoreStatus) {
      scoreStatus.textContent = `Clasificación ${result.classification.label}`;
      scoreStatus.dataset.tone = result.classification.tone;
    }
    if (scoreSummary) scoreSummary.textContent = result.classification.summary;
    if (reportScore) reportScore.textContent = result.globalScore;
    if (reportClassification) {
      reportClassification.textContent = `Clasificación ${result.classification.label}`;
      reportClassification.dataset.tone = result.classification.tone;
    }

    fillList("[data-critical-areas]", result.criticalAreas, (item) => `${item.area}: ${item.score}/100`);
    fillList("[data-priorities]", result.priorities, (item) => item);
    fillList("[data-risks]", result.risks.slice(0, 6), (item) => `${item.area}: ${item.risk}`);
    renderBreakdown(result.areaScores);
  };

  const fillList = (selector, items, formatter) => {
    const list = document.querySelector(selector);
    if (!list) return;
    const content = items.length ? items : ["Sin incidencias críticas detectadas en esta fase."];
    list.innerHTML = content.map((item) => `<li>${formatter(item)}</li>`).join("");
  };

  const renderBreakdown = (areaScores) => {
    const wrapper = document.querySelector("[data-area-breakdown]");
    if (!wrapper) return;

    wrapper.innerHTML = areaScores
      .map(
        (item) => `
          <article class="area-score-row">
            <div>
              <strong>${item.area}</strong>
              <span>${item.negatives} respuestas negativas · ${item.partials} parciales</span>
            </div>
            <div class="area-score-bar" aria-label="${item.area} ${item.score} de 100">
              <span style="width: ${item.score}%"></span>
            </div>
            <strong>${item.score}</strong>
          </article>
        `
      )
      .join("");
  };

  const buildPayload = () => ({
    company: state.company,
    answers: diagnosticQuestions.map((question, index) => ({
      area: question.area,
      question: question.text,
      answer: answerLabels[state.answers[index]]
    })),
    result: state.result,
    integrations: {
      crm: "ready_for_lead_create",
      emailMarketing: "ready_for_segmentation",
      automations: "ready_for_workflow_trigger",
      aiDocumentation: "ready_for_document_generation_prompt",
      stripe: "ready_for_plan_mapping"
    },
    source: state.source,
    leadStage: "qualified_diagnostic_completed",
    conversionPath: "landing_to_diagnostic_to_demo_or_pdf",
    createdAt: new Date().toISOString()
  });

  const parseEmployees = (value) => {
    if (value === "1-10") return 10;
    if (value === "11-50") return 50;
    if (value === "51-250") return 250;
    if (value === "Más de 250") return 251;
    return Number(value || 0);
  };

  const recommendedPlanFromResult = (result, employees) => {
    const count = parseEmployees(employees);
    if (count > 250) return "Personalizado";
    if (result.globalScore < 50 || count > 50) return "Premium";
    if (count > 10) return "Pro";
    return "Starter";
  };

  const monthlyRevenueFromPlan = (plan) => {
    if (plan === "Starter") return 29;
    if (plan === "Pro") return 79;
    if (plan === "Premium") return 149;
    return 590;
  };

  const priorityFromResult = (result) => {
    if (result.globalScore < 50 || result.criticalAreas.length >= 3) return "Alta";
    if (result.globalScore < 75 || result.criticalAreas.length >= 1) return "Media";
    return "Baja";
  };

  const createCrmId = (prefix) =>
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  const loadCrmState = () => {
    try {
      return JSON.parse(localStorage.getItem("legalprevent-crm-v1") || "null");
    } catch {
      return null;
    }
  };

  const saveLeadToCrm = () => {
    const result = state.result;
    if (!result) return null;

    const now = new Date();
    const nextActionAt = new Date(now);
    nextActionAt.setDate(nextActionAt.getDate() + 1);

    const plan = recommendedPlanFromResult(result, state.company.employees);
    const leadId = state.crmLeadId || createCrmId("lead");
    const ownerId = "u-2";
    const riskScore = 100 - result.globalScore;
    const lead = {
      id: leadId,
      companyName: state.company.company,
      contactName: state.company.company,
      email: state.company.email,
      phone: state.company.phone,
      sector: state.company.sector,
      employees: parseEmployees(state.company.employees),
      city: "",
      source: "Web",
      status: "Interesado",
      priority: priorityFromResult(result),
      createdAt: now.toISOString(),
      lastInteractionAt: now.toISOString(),
      nextActionAt: nextActionAt.toISOString(),
      nextAction: "Contactar para revisar diagnóstico y agendar demo.",
      notes: [
        `Lead generado desde diagnóstico web (${state.source}).`,
        `Cumplimiento: ${result.globalScore}/100 (${result.classification.label}).`,
        `Áreas críticas: ${result.criticalAreas.map((item) => `${item.area} ${item.score}/100`).join(", ") || "Sin áreas críticas"}.`,
        `Prioridades: ${result.priorities.join(" | ")}`
      ].join("\n"),
      ownerId,
      recommendedPlan: plan,
      estimatedMonthlyRevenue: monthlyRevenueFromPlan(plan),
      riskScore
    };

    const crmState = loadCrmState() || {
      users: [
        { id: "u-1", name: "Marta Ruiz", email: "marta@legalprevent.com", role: "admin" },
        { id: "u-2", name: "Alvaro Navas", email: "alvaro@legalprevent.com", role: "sales" }
      ],
      currentUserId: "u-1",
      leads: [],
      clients: [],
      tasks: [],
      interactions: [],
      proposals: [],
      payments: [],
      documents: [],
      notes: [],
      activityLog: [],
      alerts: [],
      meta: { seededAt: now.toISOString(), version: 1, source: "legalprevent_web_bridge" }
    };

    crmState.leads = crmState.leads || [];
    crmState.interactions = crmState.interactions || [];
    crmState.tasks = crmState.tasks || [];
    crmState.documents = crmState.documents || [];
    crmState.activityLog = crmState.activityLog || [];

    const existingIndex = crmState.leads.findIndex(
      (item) => item.email === lead.email && item.companyName === lead.companyName
    );

    if (existingIndex >= 0) {
      lead.id = crmState.leads[existingIndex].id;
      lead.createdAt = crmState.leads[existingIndex].createdAt || lead.createdAt;
      crmState.leads[existingIndex] = { ...crmState.leads[existingIndex], ...lead };
      state.crmLeadId = lead.id;
    } else {
      crmState.leads.unshift(lead);
      state.crmLeadId = lead.id;
    }

    crmState.interactions.unshift({
      id: createCrmId("int"),
      type: "Nota manual",
      relatedType: "lead",
      relatedId: lead.id,
      date: now.toISOString(),
      description: `Diagnóstico completado: ${result.globalScore}/100, clasificación ${result.classification.label}.`,
      createdBy: ownerId
    });

    crmState.tasks.unshift({
      id: createCrmId("task"),
      title: `Contactar a ${lead.companyName}`,
      description: "Lead captado desde el diagnóstico web. Revisar informe y proponer demo.",
      relatedType: "lead",
      relatedId: lead.id,
      dueDate: nextActionAt.toISOString(),
      priority: lead.priority,
      status: "Pendiente",
      ownerId
    });

    crmState.documents.unshift({
      id: createCrmId("doc"),
      relatedType: "lead",
      relatedId: lead.id,
      name: "Informe de diagnóstico inicial",
      type: "diagnostic",
      createdAt: now.toISOString()
    });

    crmState.activityLog.unshift({
      id: createCrmId("log"),
      entityType: "lead",
      entityId: lead.id,
      action: existingIndex >= 0 ? "diagnostic_update" : "diagnostic_create",
      detail: `Lead ${existingIndex >= 0 ? "actualizado" : "creado"} desde diagnóstico web.`,
      createdAt: now.toISOString(),
      createdBy: ownerId
    });

    localStorage.setItem("legalprevent-crm-v1", JSON.stringify(crmState));
    sessionStorage.setItem("lp_last_crm_lead_id", lead.id);
    console.info("LEGAL PREVENT CRM lead saved", lead);
    return lead;
  };

  const pdfText = (value) => {
    const clean = String(value ?? "").replace(/[^\S\r\n]+/g, " ").trim();
    let escaped = "";
    for (let index = 0; index < clean.length; index += 1) {
      const char = clean[index];
      const code = clean.charCodeAt(index);
      if (char === "\\" || char === "(" || char === ")") {
        escaped += `\\${char}`;
      } else if (code < 32 || code > 255) {
        escaped += " ";
      } else {
        escaped += char;
      }
    }
    return `(${escaped})`;
  };

  const wrapPdfText = (value, maxChars = 82) => {
    const words = String(value ?? "").replace(/\s+/g, " ").trim().split(" ");
    const lines = [];
    let line = "";
    words.forEach((word) => {
      const next = line ? `${line} ${word}` : word;
      if (next.length > maxChars && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    });
    if (line) lines.push(line);
    return lines;
  };

  const reportTone = (score) => {
    if (score >= 80) return { label: "Controlado", rgb: "22 128 60", summary: "La empresa presenta una base de cumplimiento razonablemente estructurada." };
    if (score >= 60) return { label: "Prioritario", rgb: "180 83 9", summary: "La empresa tiene una base parcial, pero conviene actuar sobre brechas documentales y evidencias." };
    return { label: "Crítico", rgb: "180 35 24", summary: "La empresa presenta brechas relevantes que requieren un plan de regularización ordenado." };
  };

  const recommendedActions = (area) => [
    `Revisar evidencias y responsables vinculados a ${area.area}.`,
    "Definir un calendario de corrección con prioridad, responsable y fecha objetivo.",
    "Conservar trazabilidad documental de cada medida implantada."
  ];

  const createProfessionalPdfBlob = (payload) => {
    const pages = [];
    let commands = [];
    let y = 780;
    const margin = 48;
    const tone = reportTone(payload.result.globalScore);
    const today = new Intl.DateTimeFormat("es-ES", { day: "2-digit", month: "long", year: "numeric" }).format(new Date());

    const add = (command) => commands.push(command);
    const pdfRgb = (rgb) =>
      rgb
        .split(" ")
        .map((channel) => (Number(channel) / 255).toFixed(3))
        .join(" ");
    const color = (rgb) => add(`${pdfRgb(rgb)} rg`);
    const stroke = (rgb) => add(`${pdfRgb(rgb)} RG`);
    const rect = (x, top, width, height, rgb) => {
      color(rgb);
      add(`${x} ${top - height} ${width} ${height} re f`);
    };
    const line = (x1, y1, x2, y2, rgb = "217 224 234") => {
      stroke(rgb);
      add(`${x1} ${y1} m ${x2} ${y2} l S`);
    };
    const text = (value, x, top, size = 10, font = "F1", rgb = "15 23 42") => {
      color(rgb);
      add(`BT /${font} ${size} Tf ${x} ${top} Td ${pdfText(value)} Tj ET`);
    };
    const paragraph = (value, x, top, maxChars = 82, size = 10, leading = 15, font = "F1", rgb = "51 65 85") => {
      let cursor = top;
      wrapPdfText(value, maxChars).forEach((lineText) => {
        text(lineText, x, cursor, size, font, rgb);
        cursor -= leading;
      });
      return cursor;
    };
    const footer = (pageNumber) => {
      line(margin, 46, 547, 46, "226 232 240");
      text("LEGAL PREVENT | Informe de diagnóstico preventivo", margin, 28, 8, "F2", "71 85 105");
      text(`Página ${pageNumber}`, 500, 28, 8, "F1", "100 116 139");
    };
    const newPage = () => {
      if (commands.length) {
        footer(pages.length + 1);
        pages.push(commands.join("\n"));
      }
      commands = [];
      y = 780;
    };
    const ensureSpace = (height = 90) => {
      if (y - height < 70) newPage();
    };
    const sectionTitle = (label, title) => {
      ensureSpace(54);
      text(label.toUpperCase(), margin, y, 8, "F2", "30 94 255");
      y -= 19;
      text(title, margin, y, 18, "F2", "15 23 42");
      y -= 24;
    };
    const bullet = (value, x = margin, maxChars = 82) => {
      ensureSpace(34);
      text("-", x, y, 10, "F2", "30 94 255");
      y = paragraph(value, x + 14, y, maxChars, 9.5, 14, "F1", "51 65 85") - 4;
    };

    rect(0, 842, 595, 842, "248 250 252");
    rect(0, 842, 595, 172, "15 23 42");
    rect(48, 752, 62, 62, "30 94 255");
    text("LP", 67, 712, 24, "F2", "255 255 255");
    text("LEGAL PREVENT", 128, 724, 12, "F2", "255 255 255");
    text("Informe de diagnóstico preventivo", 128, 695, 28, "F2", "255 255 255");
    text("Cumplimiento legal inteligente para empresas modernas", 128, 672, 11, "F1", "203 213 225");

    rect(48, 610, 499, 118, "255 255 255");
    text(payload.company.company || "Empresa analizada", 70, 570, 22, "F2", "15 23 42");
    text(`Fecha de emisión: ${today}`, 70, 544, 10, "F1", "71 85 105");
    text(`Sector: ${payload.company.sector || "No indicado"} | Empleados: ${payload.company.employees || "No indicado"}`, 70, 526, 10, "F1", "71 85 105");
    text(`Contacto: ${payload.company.email || "No indicado"} | ${payload.company.phone || "Sin teléfono"}`, 70, 508, 10, "F1", "71 85 105");

    rect(48, 450, 230, 112, "255 255 255");
    text("Nivel de cumplimiento", 70, 412, 10, "F2", "71 85 105");
    text(`${payload.result.globalScore}/100`, 70, 372, 34, "F2", tone.rgb);
    text(`Clasificación: ${payload.result.classification.label}`, 70, 344, 11, "F2", "15 23 42");

    rect(300, 450, 247, 112, "255 255 255");
    text("Resumen ejecutivo", 322, 412, 10, "F2", "71 85 105");
    paragraph(tone.summary, 322, 390, 38, 10, 15, "F1", "51 65 85");

    y = 280;
    text("Este informe es una evaluación preliminar orientada a priorizar acciones de prevención legal.", margin, y, 10, "F1", "51 65 85");
    y -= 18;
    text("No sustituye el asesoramiento jurídico individualizado ni una auditoría completa.", margin, y, 10, "F1", "51 65 85");

    newPage();
    sectionTitle("01", "Resumen ejecutivo");
    bullet(`Puntuación global: ${payload.result.globalScore}/100, con clasificación ${payload.result.classification.label}.`);
    bullet(`Áreas críticas detectadas: ${payload.result.criticalAreas.length ? payload.result.criticalAreas.map((item) => item.area).join(", ") : "sin áreas críticas en esta fase"}.`);
    bullet(`Plan recomendado: ${recommendedPlanFromResult(payload.result, payload.company.employees)} según tamaño, score y complejidad inicial.`);
    bullet("Objetivo inmediato: convertir el diagnóstico en un plan de prevención con responsables, evidencias y calendario de seguimiento.");

    sectionTitle("02", "Scoring por áreas");
    payload.result.areaScores.forEach((item) => {
      ensureSpace(34);
      text(item.area, margin, y, 10, "F2", "15 23 42");
      rect(230, y + 7, 230, 9, "226 232 240");
      rect(230, y + 7, Math.max(4, (item.score / 100) * 230), 9, item.score >= 80 ? "22 163 74" : item.score >= 60 ? "245 158 11" : "220 38 38");
      text(`${item.score}/100`, 480, y, 10, "F2", "15 23 42");
      y -= 25;
    });

    sectionTitle("03", "Plan de acción recomendado");
    const critical = payload.result.criticalAreas.length ? payload.result.criticalAreas : payload.result.areaScores.slice().sort((a, b) => a.score - b.score).slice(0, 2);
    critical.slice(0, 3).forEach((area, index) => {
      ensureSpace(96);
      rect(margin, y + 16, 499, 78, index === 0 ? "239 246 255" : "248 250 252");
      text(`${index + 1}. ${area.area}`, margin + 16, y - 8, 12, "F2", "15 23 42");
      y -= 28;
      recommendedActions(area).forEach((action) => {
        text(`- ${action}`, margin + 20, y, 8.8, "F1", "51 65 85");
        y -= 13;
      });
      y -= 13;
    });

    newPage();
    sectionTitle("04", "Riesgos detectados");
    const risks = payload.result.risks.length ? payload.result.risks : [{ area: "General", risk: "No se han detectado riesgos críticos en esta fase, aunque recomendamos conservar evidencias y revisiones periódicas." }];
    risks.slice(0, 14).forEach((item) => bullet(`${item.area}: ${item.risk}`));

    sectionTitle("05", "Próximos pasos");
    payload.result.priorities.forEach((item) => bullet(item));
    bullet("Agendar una revisión guiada para validar respuestas, evidencias disponibles y obligaciones aplicables.");
    bullet("Centralizar documentación, responsables y alertas recurrentes en una herramienta de seguimiento.");

    sectionTitle("06", "Nota legal y alcance");
    paragraph(
      "Este documento tiene finalidad informativa y preventiva. Se basa en las respuestas facilitadas por la empresa y no constituye asesoramiento jurídico individualizado, dictamen profesional ni auditoría legal completa. Para decisiones concretas o situaciones de riesgo, debe revisarse el caso con asesoramiento profesional cualificado.",
      margin,
      y,
      92,
      9.5,
      14,
      "F1",
      "51 65 85"
    );

    newPage();

    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`
    ];
    pages.forEach((page, index) => {
      const pageObject = 3 + index * 2;
      const contentObject = pageObject + 1;
      objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 100 0 R /F2 101 0 R >> >> /Contents ${contentObject} 0 R >>`);
      objects.push(`<< /Length ${page.length} >> stream\n${page}\nendstream`);
    });
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((object, index) => {
      offsets.push(pdf.length);
      const objectNumber = index < objects.length - 2 ? index + 1 : index === objects.length - 2 ? 100 : 101;
      pdf += `${objectNumber} 0 obj ${object} endobj\n`;
    });
    const xrefOffset = pdf.length;
    pdf += `xref\n0 102\n0000000000 65535 f \n`;
    const offsetMap = new Map();
    objects.forEach((_, index) => {
      const objectNumber = index < objects.length - 2 ? index + 1 : index === objects.length - 2 ? 100 : 101;
      offsetMap.set(objectNumber, offsets[index + 1]);
    });
    for (let objectNumber = 1; objectNumber <= 101; objectNumber += 1) {
      const offset = offsetMap.get(objectNumber);
      pdf += offset ? `${String(offset).padStart(10, "0")} 00000 n \n` : "0000000000 65535 f \n";
    }
    pdf += `trailer << /Size 102 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

    const bytes = Uint8Array.from(pdf, (char) => char.charCodeAt(0) & 0xff);
    return new Blob([bytes], { type: "application/pdf" });
  };

  const downloadReport = () => {
    const payload = buildPayload();
    const blob = createProfessionalPdfBlob(payload);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `legal-prevent-informe-diagnostico-${Date.now()}.pdf`;
    link.click();
    URL.revokeObjectURL(url);
  };

  renderQuestions();
  applyLandingPrefill();
  updateQuestionProgress();

  document.querySelector("[data-diagnostic-step='1']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    state.company = Object.fromEntries(new FormData(event.currentTarget).entries());
    showStep(2);
  });

  document.querySelector("[data-run-scoring]")?.addEventListener("click", () => {
    if (Object.keys(state.answers).length < diagnosticQuestions.length) {
      const missing = diagnosticQuestions.length - Object.keys(state.answers).length;
      alert(`Faltan ${missing} preguntas por responder.`);
      return;
    }
    const result = calculateResult();
    renderResult(result);
    const crmLead = saveLeadToCrm();
    window.LegalPreventSupabase?.createLead({
      eventType: "diagnostic_completed",
      leadStage: "qualified_diagnostic_completed",
      payload: buildPayload(),
      crmLead,
      page: window.location.href
    });
    window.LegalPreventSupabase?.createDiagnostic({
      eventType: "diagnostic_completed",
      payload: buildPayload(),
      crmLead,
      page: window.location.href
    });
    console.info("LEGAL PREVENT diagnostic payload", { ...buildPayload(), crmLead });
    showStep(3);
  });

  document.querySelector("[data-view-report]")?.addEventListener("click", () => showStep(4));
  document.querySelector("[data-next-capture]")?.addEventListener("click", () => showStep(5));
  document.querySelectorAll("[data-back-step]").forEach((button) => {
    button.addEventListener("click", () => showStep(button.dataset.backStep));
  });
  document.querySelector("[data-download-report]")?.addEventListener("click", () => {
    downloadReport();
    const feedback = document.querySelector("[data-diagnostic-feedback]");
    if (feedback) feedback.textContent = "Informe profesional descargado. Puedes compartirlo internamente o revisarlo con nuestro equipo.";
  });
  document.querySelector("[data-demo-request]")?.addEventListener("click", () => {
    const crmLead = saveLeadToCrm();
    window.LegalPreventSupabase?.createLead({
      eventType: "diagnostic_demo_requested",
      leadStage: "diagnostic_to_demo",
      payload: buildPayload(),
      crmLead,
      page: window.location.href
    });
    console.info("LEGAL PREVENT demo request from diagnostic", { ...buildPayload(), crmLead });
  });
}
