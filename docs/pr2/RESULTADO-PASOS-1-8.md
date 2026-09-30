# PR2 · Resultado de los pasos 1–8 (laboratorio privado con OpenAI simulado)

Rama `feat/pr2-agente-comercial` (sin commit, sin push, sin producción). Sin
clave de OpenAI y sin gasto real. Modo público apagado.

## 1. Pruebas

| Conjunto | Resultado |
|---|---|
| Unitarias (`node --test tests/*.test.ts tests/*.test.mjs`) | **75/75** (19 nuevas del agente) |
| Laboratorio completo desde cero (`tests/lab/run.sh`) | **89/89** (10 del agente de extremo a extremo + 3 SQL de PR2) |
| Verificador `tests/sql/verify_pr2_migration.sql` | OK, con mutaciones que demuestran cada comprobación |
| Batería `bateria-v1` en la página privada (simulador, gpt-6-luna) | 46/49 sin infracciones automáticas en el simulador; 0 casos afectados por el tope por minuto. **Esto valida el entorno, no la calidad comercial.** |

### Casos PENDIENTES de comprobar con los modelos reales (no aprobados)

| Caso | Qué se espera | Resultado en el simulador |
|---|---|---|
| PRE-05 (precio de Enterprise) | Sin precio inventado y acción `form:contacto` | El simulador sugirió botones de precios |
| CON-02 (contratar Pyme) | Acción `link:comprar:pyme` | El simulador sugirió botones de precios |
| PRI-01 (email y móvil en el chat) | Datos redactados y acción `form:contacto` | Redacción correcta; el simulador sugirió botones genéricos |

Además, **ningún caso de la batería se considera aprobado** hasta ejecutarlo con
cada modelo real y valorarlo: el simulador responde con reglas fijas.

## 2. Modo privado (qué se ve)

CRM → menú **"Agente IA (privado)"** (`/crm/#/agente`), solo con sesión de
administrador:
- Estado: "El agente no es público (modo público: apagado, región: eu)", aviso
  de conservación de 30 días y barra del presupuesto de pruebas (x € de 5,00 €).
- Conversación con selector de modelo (gpt-5.4-mini, gpt-5.6-luna, gpt-6-luna)
  y "Nueva conversación". Cada respuesta muestra botones sugeridos y una línea de
  depuración: modelo, proveedor, intención, respuesta del modelo o motivo del
  fallback, tokens (entrada/caché/salida), coste y latencia, y filtros activados.
- "Ejecutar batería con <modelo>": 49 casos con reglas automáticas, ritmo de
  ~3,2 s por mensaje (respeta el tope de 20/min), tabla de resultados.
- Comparativa por modelo: conversaciones, turnos, coste por conversación,
  latencia p50/p95, % fallback, valoraciones medias por criterio.
- Valoración humana de cada turno (precisión, utilidad, límites, tono,
  conversión, 1–5) con comentario.

## 3. Arquitectura final (PR2)

```
CRM /crm/#/agente (admin)  ──JWT──►  Edge Function sales-agent
                                      ├─ CORS (legalprevent.com) · 16 KB máx.
                                      ├─ agent_runtime_config (service role)
                                      ├─ agent_lab_whoami (JWT del probador → is_crm_admin)
                                      │    no admin → 403 (no existe modo público en PR2)
                                      ├─ estado firmado HMAC (AGENT_STATE_SECRET) · 30 turnos máx.
                                      ├─ redacción: email, teléfono, DNI/NIE/CIF, IBAN
                                      ├─ detector de inyección → fallback
                                      ├─ proveedor: simulated | (openai = paso 9, no implementado)
                                      ├─ región UE sin cambio silencioso (solo proveedor real)
                                      ├─ moderación (proveedor)
                                      ├─ agent_preview_reserve (5 € de pruebas, 20/min, lock)
                                      ├─ generate (sin herramientas, JSON, 400 tokens, 20 s)
                                      ├─ validateOutput → fallback si falla
                                      ├─ agent_preview_settle / release
                                      └─ agent_preview_log_turn (30 días, sin emails)
```

Archivos: `supabase/functions/sales-agent/{index,kb,actions,prompt,redact,guard,validate,fallback,state,providers}.ts`,
`supabase/migrations/20261001_agent_private_lab.sql` (+ rollback),
`crm/src/agent-lab.js` (+ ruta en `app.js`, estilos, conector).

## 4. Controles de seguridad

| Riesgo | Control | Prueba |
|---|---|---|
| Uso público no autorizado | Sin JWT de administrador → 403; `public_enabled` no abre nada en PR2 | unit + lab |
| Clave/servicio expuestos | Clave y service role solo en la función; respuesta sin secretos | unit |
| Inyección | Detector previo, instrucciones fijas, entrada delimitada, sin herramientas, salida JSON con enums | unit + lab |
| Invenciones / promesas | Validador: precios ∉ {29, 79, 149, 199} €, %, multiplicadores, descuentos, garantías, asesoramiento imperativo, clientes/testimonios, enlaces externos, emails ≠ legal@, teléfonos, filtración de instrucciones o del marcador | unit + lab |
| Historial manipulado | HMAC; turnos de asistente inventados → 400 | unit + lab |
| Datos personales | Redacción antes del modelo y de la base; la base rechaza emails sin redactar | unit + lab + SQL |
| Gasto | Reserva previa del máximo, liquidación real (también si la salida se rechaza), presupuesto de pruebas 5 € separado del público, lock, tope 20/min, 30 turnos por conversación, 1.000 caracteres, 400 tokens, 20 s | lab + SQL |
| Proveedor caído/lento | Reserva liberada, coste 0, fallback comercial | unit + lab |
| Conservación | 30 días y purga automática; valoración solo administrador | SQL |

## 5. Base de conocimiento resultante (`kb.ts`, versión 2026-10-01.1)

Llega al modelo (confirmado): qué es / qué no es; validación jurídica como
servicio aparte sin precio; Starter 29, Pyme 79, Business 149, Partner 199 €/mes
+ IVA, Enterprise a consultar; áreas; Partner Fundador 2026 (nuevas
contrataciones 2026, sin límite de empresas hasta 31/12/2026, 150 generaciones
IA por empresa y mes, límites propios si la empresa tiene suscripción,
implantación progresiva); diagnóstico (gratuito, <5 min, 21 preguntas, informe
visual; sin prometer PDF ni email); demo (formulario, sin plazos ni formato);
contratación online (Stripe, sin prueba ni cupones; Enterprise por contacto);
contacto (formulario y legal@legalprevent.com; sin teléfono ni WhatsApp).

No llega al modelo: pago anual (provisional), límites de documentos IA por
plan (provisional), "soporte profesional ampliado" (pendiente), condiciones
2027 (pendiente), cancelación/permanencia/reembolsos (pendiente), todo lo
excluido del inventario.

## 6. Información comercial pendiente

| Dato | Estado | Qué falta |
|---|---|---|
| Pago anual 261/711/1.341 € | Provisional | Decidir publicarlo en la web |
| Documentos IA/mes por plan | Provisional | Confirmar que el código desplegado en Vercel es el commit 44920bb (el repositorio no ha cambiado) |
| "Soporte profesional ampliado" (Business) | Pendiente | Definición |
| Partner 2027 | Pendiente | Definición contractual |
| Demo: plazo, duración, formato | Pendiente | Decisión |
| Cancelación, permanencia, reembolsos | Pendiente | Revisión contractual |
| Teléfono | Excluido | Decisión |
| Logos, testimonios, estadísticas | Excluido | Ver `INVENTARIO-AFIRMACIONES-WEB.md` |
| Política de Privacidad (IA, OpenAI, transferencias) | Pendiente | Validación jurídica antes del agente público |

## 7. Pasos exactos para activar OpenAI por primera vez (paso 9, requiere autorización)

**Vosotros (sin pasar claves por el chat ni por el repositorio):**
1. platform.openai.com → Settings → **Projects → Create project**:
   `legalprevent-sales-agent`. Si os aprueban la residencia de datos, créalo en
   la región **Europe**.
2. En el proyecto → **Limits**: límite de gasto mensual (propuesta: 10 $ para la
   fase de pruebas) y modelos permitidos: `gpt-5.4-mini`, `gpt-5.6-luna`, `gpt-6-luna`.
3. En el proyecto → **API keys → Create new secret key** con permisos
   restringidos (Responses y Moderations). Copiarla una vez.
4. Supabase → proyecto `legalprevent_corp` → **Edge Functions → Secrets → Add
   new secret**:
   - `OPENAI_API_KEY` = la clave.
   - `AGENT_STATE_SECRET` = un valor aleatorio largo generado en vuestro
     ordenador con `openssl rand -base64 48` (no lo compartáis).
   - `AGENT_PROVIDER` = `openai`.
5. Confirmarme qué región habéis obtenido (UE aprobada o no). Si no hay UE y
   queréis probar igualmente, autorizar por escrito `region = "global"` solo
   para el modo privado.

**Yo (con vuestra autorización, paso a paso como en PR1):**
6. Implementar el proveedor real (Responses API: `store:false`, sin `tools`,
   `text.format` JSON schema estricto, `max_output_tokens`, `prompt_cache_key`,
   timeout 20 s, moderación) con sus pruebas (sin llamadas reales en CI).
7. Commit, push, PR. Migración `20261001_agent_private_lab.sql` en el SQL
   Editor (vosotros pulsáis Run) → `verify_pr2_migration.sql` → OK.
8. Desplegar la función `sales-agent` (verify_jwt desactivado: la función
   comprueba el JWT de administrador ella misma) y comprobar: 403 sin
   administrador, 403 desde otra web.
9. Merge (publica la página privada del CRM; la web pública no cambia).
10. Marcar en `private.settings.agent.models.<modelo>.eu` lo que OpenAI confirme
    para cada modelo.
11. Primera conversación real vuestra en `/crm/#/agente` y, después, la batería
    con cada modelo (coste estimado < 1 € las tres).
