// Simulación de migración del CRM (LP-CRM-002). Solo lee una copia exportada
// desde el CRM ("Exportar copia") y muestra qué se importaría. No escribe nada,
// no conecta con Supabase y no modifica el fichero de entrada.
//
// Uso: node tools/crm-migracion-simulacion.mjs <copia.json>

import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Uso: node tools/crm-migracion-simulacion.mjs <copia.json>");
  process.exit(2);
}

const backup = JSON.parse(readFileSync(file, "utf8"));
const data = backup.data || backup;
const kinds = { client: data.clients || [], task: data.tasks || [], interaction: data.interactions || [], proposal: data.proposals || [] };
const leadIds = new Set((data.leads || []).map((lead) => lead.id));
const clientIds = new Set((data.clients || []).map((client) => client.id));

const report = { totals: {}, duplicates: [], missingIds: [], danglingRelations: [] };

for (const [kind, items] of Object.entries(kinds)) {
  report.totals[kind] = items.length;
  const seen = new Set();
  for (const item of items) {
    if (!item.id) {
      report.missingIds.push(kind);
      continue;
    }
    if (seen.has(item.id)) report.duplicates.push(`${kind}:${item.id}`);
    seen.add(item.id);
  }
}

const exists = (type, id) => (type === "lead" ? leadIds.has(id) : type === "client" ? clientIds.has(id) : false);
for (const task of kinds.task) {
  if (task.relatedType && !exists(task.relatedType, task.relatedId)) report.danglingRelations.push(`task:${task.id}`);
}
for (const item of kinds.interaction) {
  if (item.relatedType && !exists(item.relatedType, item.relatedId)) report.danglingRelations.push(`interaction:${item.id}`);
}
for (const proposal of kinds.proposal) {
  const ok = (proposal.relatedLeadId && leadIds.has(proposal.relatedLeadId)) || (proposal.relatedClientId && clientIds.has(proposal.relatedClientId));
  if (!ok) report.danglingRelations.push(`proposal:${proposal.id}`);
}

const wouldWrite = Object.values(report.totals).reduce((sum, value) => sum + value, 0);
console.log(JSON.stringify({
  mode: "simulacion-sin-escritura",
  source: file,
  exportedAt: backup.exportedAt || null,
  wouldWriteRecords: wouldWrite,
  ...report,
  blocking: report.duplicates.length > 0 || report.missingIds.length > 0,
  note: "Los registros con relaciones huérfanas se importan igualmente y se marcan para revisión.",
}, null, 2));
