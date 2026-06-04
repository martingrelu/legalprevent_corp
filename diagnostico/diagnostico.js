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

  const escapePdfText = (value) =>
    String(value)
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/[^\x20-\x7E]/g, "");

  const createPdfBlob = (lines) => {
    const textCommands = lines
      .slice(0, 42)
      .map((line, index) => `BT /F1 10 Tf 50 ${770 - index * 16} Td (${escapePdfText(line)}) Tj ET`)
      .join("\n");
    const objects = [
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj",
      "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
      `5 0 obj << /Length ${textCommands.length} >> stream\n${textCommands}\nendstream endobj`
    ];

    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((object) => {
      offsets.push(pdf.length);
      pdf += `${object}\n`;
    });
    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.slice(1).forEach((offset) => {
      pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    });
    pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

    return new Blob([pdf], { type: "application/pdf" });
  };

  const downloadReport = () => {
    const payload = buildPayload();
    const lines = [
      "LEGAL PREVENT - Informe de diagnostico inicial",
      "",
      `Empresa: ${payload.company.company}`,
      `Email: ${payload.company.email}`,
      `Telefono: ${payload.company.phone}`,
      `Empleados: ${payload.company.employees}`,
      `Sector: ${payload.company.sector}`,
      "",
      `Puntuacion: ${payload.result.globalScore}/100`,
      `Clasificacion: ${payload.result.classification.label}`,
      "",
      "Areas:",
      ...payload.result.areaScores.map((item) => `- ${item.area}: ${item.score}/100`),
      "",
      "Prioridades:",
      ...payload.result.priorities.map((item) => `- ${item}`),
      "",
      "Riesgos detectados:",
      ...payload.result.risks.map((item) => `- ${item.area}: ${item.risk}`),
      "",
      "Nota: PDF inicial generado en cliente. En produccion puede sustituirse por generacion PDF server-side o IA documental."
    ];

    const blob = createPdfBlob(lines);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `legal-prevent-diagnostico-${Date.now()}.pdf`;
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
    if (feedback) feedback.textContent = "Informe preparado para descarga. En producción se conectará a generación PDF avanzada.";
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
