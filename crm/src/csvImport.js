export const CSV_LEAD_FIELDS = [
  { key: "companyName", label: "Empresa", required: true, aliases: ["empresa", "gestoria", "company", "company name", "razon social"] },
  { key: "contactName", label: "Persona de contacto", required: true, aliases: ["persona de contacto", "contacto", "nombre", "contact name"] },
  { key: "email", label: "Email", required: true, aliases: ["email", "correo", "correo electronico", "e-mail"] },
  { key: "phone", label: "Teléfono", aliases: ["telefono", "teléfono", "phone", "movil", "móvil"] },
  { key: "sector", label: "Sector", aliases: ["sector", "actividad"] },
  { key: "employees", label: "Empleados", aliases: ["empleados", "employees", "trabajadores"] },
  { key: "city", label: "Ciudad/provincia", aliases: ["ciudad", "provincia", "ciudad/provincia", "ubicacion", "ubicación"] },
  { key: "source", label: "Fuente", aliases: ["fuente", "source", "canal"] },
  { key: "status", label: "Estado", aliases: ["estado", "status", "fase"] },
  { key: "priority", label: "Prioridad", aliases: ["prioridad", "priority"] },
  { key: "nextActionAt", label: "Fecha seguimiento", aliases: ["fecha seguimiento", "fecha proxima accion", "próxima fecha", "next action date"] },
  { key: "nextAction", label: "Próxima acción", aliases: ["proxima accion", "próxima acción", "seguimiento", "next action"] },
  { key: "notes", label: "Notas", aliases: ["notas", "notes", "observaciones"] },
  { key: "recommendedPlan", label: "Plan recomendado", aliases: ["plan recomendado", "plan"] },
  { key: "estimatedMonthlyRevenue", label: "MRR estimado", aliases: ["mrr estimado", "mrr", "ingreso mensual"] },
  { key: "riskScore", label: "Riesgo 0-100", aliases: ["riesgo", "risk score", "puntuacion riesgo", "puntuación riesgo"] },
];

const normalize = (value) => String(value || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .trim()
  .toLowerCase();

export function detectDelimiter(text) {
  const firstLine = String(text || "").split(/\r?\n/, 1)[0] || "";
  const counts = [",", ";", "\t"].map((delimiter) => ({
    delimiter,
    count: parseCsvLine(firstLine, delimiter).length,
  }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0].count > 1 ? counts[0].delimiter : ",";
}

function parseCsvLine(line, delimiter) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

export function parseCsv(text) {
  const cleanText = String(text || "").replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(cleanText);
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < cleanText.length; index += 1) {
    const char = cleanText[index];
    if (char === '"') {
      if (quoted && cleanText[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && cleanText[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell.trim());
  if (row.some((value) => value !== "")) rows.push(row);
  if (quoted) throw new Error("El CSV contiene comillas sin cerrar.");
  if (rows.length < 2) throw new Error("El CSV debe incluir una cabecera y al menos un contacto.");

  const headers = rows[0].map((header, index) => header || `Columna ${index + 1}`);
  return {
    delimiter,
    headers,
    rows: rows.slice(1).map((values, index) => ({ line: index + 2, values })),
  };
}

export function suggestMapping(headers) {
  const used = new Set();
  return Object.fromEntries(CSV_LEAD_FIELDS.map((field) => {
    const aliases = [field.label, field.key, ...field.aliases].map(normalize);
    const index = headers.findIndex((header, headerIndex) => !used.has(headerIndex) && aliases.includes(normalize(header)));
    if (index >= 0) used.add(index);
    return [field.key, index];
  }));
}

export function mapCsvRow(row, mapping, defaults = {}) {
  const lead = { ...defaults };
  CSV_LEAD_FIELDS.forEach((field) => {
    const index = Number(mapping[field.key]);
    if (Number.isInteger(index) && index >= 0) {
      const value = row.values[index] ?? "";
      if (value !== "" || !(field.key in defaults)) lead[field.key] = value;
    }
  });
  return lead;
}

export function createLeadFormData(lead) {
  const data = new FormData();
  Object.entries(lead).forEach(([key, value]) => data.set(key, value ?? ""));
  return data;
}

export function csvTemplate() {
  return [
    CSV_LEAD_FIELDS.map((field) => `"${field.label}"`).join(","),
    ['Gestoría Ejemplo', 'Ana Pérez', 'ana@ejemplo.es', '600123123', 'Servicios profesionales', '8', 'Madrid', 'Referido', 'Nuevo', 'Alta', '2026-09-01', 'Llamar para presentar LegalPrevent', 'Interesada en ampliar servicios', 'Pyme', '79', '45']
      .map((value) => `"${String(value).replace(/"/g, '""')}"`)
      .join(","),
  ].join("\r\n");
}
