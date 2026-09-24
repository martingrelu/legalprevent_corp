// JWT de laboratorio firmados con LAB_JWT_SECRET, que run.sh genera al azar en
// cada ejecución. No hay ningún secreto fijo en el repositorio.
import { createHmac } from "node:crypto";

export const SECRET = process.env.LAB_JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  throw new Error("LAB_JWT_SECRET no definido: ejecuta el laboratorio con tests/lab/run.sh");
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function sign(payload) {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: "lp-lab", exp: Math.floor(Date.now() / 1000) + 3600, ...payload });
  const signature = createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${signature}`;
}

export const ANON = sign({ role: "anon" });
export const SERVICE = sign({ role: "service_role" });
// Usuario del CRM con rol de administrador (app_metadata.crm_role = "admin"),
// como en producción, y un usuario autenticado sin ese rol.
export const AUTHENTICATED = sign({
  role: "authenticated",
  sub: "00000000-0000-4000-8000-000000000001",
  email: "crm@lab.invalid",
  app_metadata: { crm_role: "admin" },
});
export const AUTHENTICATED_NO_ADMIN = sign({
  role: "authenticated",
  sub: "00000000-0000-4000-8000-000000000002",
  email: "usuario@lab.invalid",
  app_metadata: {},
});
