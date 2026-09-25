// Gateway del laboratorio con la misma estructura de URLs que Supabase.
//   /rest/v1/*                   -> PostgREST (base migrada "new" o sin migrar "old")
//   /functions/v1/smooth-action  -> función nueva (repo) o publicada (git ref)
//   /functions/v1/stripe-webhook -> webhook de Stripe del repo (base migrada)
//   /__lab/mode?fn=&db=&resend=&cap=   cambia el escenario
//   /__lab/emails, /__lab/reset         Resend simulado
// Opcionalmente sirve la web nueva y la publicada (LAB_SITES) con
// supabase-config.js apuntando a este gateway, para pruebas manuales.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { ANON, SERVICE } from "./jwt.mjs";

const PORT = Number(process.env.LAB_GATEWAY_PORT || 54321);
const BASE = `http://127.0.0.1:${PORT}`;
const RESTS = {
  new: `http://127.0.0.1:${process.env.LAB_REST_PORT || 53000}`,
  old: `http://127.0.0.1:${process.env.LAB_REST_OLD_PORT || 53001}`,
};
const SITES = JSON.parse(process.env.LAB_SITES || "[]");

// La nueva primero (ver published-fn.mjs).
const handlers = {
  new: (await import(process.env.LAB_NEW_FUNCTION)).handleRequest,
  published: (await import("./published-fn.mjs")).handleRequest,
};
const stripeWebhook = (await import("../../supabase/functions/stripe-webhook/index.ts")).handleRequest;

// ---- Resend simulado, con la semántica de idempotencia documentada ----
const resend = { mode: "ok", delivered: [], attempts: [], keys: new Map() };
function deliver(key, body) {
  const id = `email_${resend.delivered.length + 1}`;
  resend.delivered.push({ id, key, ...body });
  if (key) resend.keys.set(key, id);
  return id;
}
async function fakeResend(init) {
  const key = init.headers?.["Idempotency-Key"] || null;
  const body = JSON.parse(init.body);
  resend.attempts.push({ key, to: body.to, subject: body.subject });
  if (resend.mode === "fail500") return new Response('{"message":"fallo simulado"}', { status: 500 });
  if (resend.mode === "accept-then-timeout") {
    if (!(key && resend.keys.has(key))) deliver(key, body);
    throw new TypeError("fetch failed (timeout simulado)");
  }
  if (key && resend.keys.has(key)) return Response.json({ id: resend.keys.get(key) });
  return Response.json({ id: deliver(key, body) });
}
const labFetch = (url, init = {}) => {
  if (String(url).startsWith("https://api.resend.com/")) return fakeResend(init);
  return fetch(url, init);
};

const env = {
  SUPABASE_URL: BASE,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  RESEND_API_KEY: "re_lab_no_real",
  LEAD_NOTIFY_EMAIL: "interno@lab.invalid",
  FROM_EMAIL: "Legal Prevent <noreply@lab.invalid>",
  ALLOWED_ORIGINS: ["http://127.0.0.1:8766", "http://127.0.0.1:8767", ...SITES.map((s) => `http://127.0.0.1:${s.port}`)].join(","),
  LEAD_NOTIFY_HOURLY_CAP: "20",
  STRIPE_WEBHOOK_SECRET: "whsec_lab_no_real",
};
const scenario = { fn: "new", db: "new" };

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
const restCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, prefer, range",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, HEAD, OPTIONS",
  "Access-Control-Expose-Headers": "content-range",
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const body = await readBody(req);
  try {
    if (url.pathname === "/__lab/emails") return res.end(JSON.stringify({ delivered: resend.delivered, attempts: resend.attempts }));
    if (url.pathname === "/__lab/reset") {
      Object.assign(resend, { mode: "ok", delivered: [], attempts: [] });
      resend.keys.clear();
      return res.end("ok");
    }
    if (url.pathname === "/__lab/mode") {
      const q = url.searchParams;
      if (q.get("fn")) scenario.fn = q.get("fn");
      if (q.get("db")) scenario.db = q.get("db");
      if (q.get("resend")) resend.mode = q.get("resend");
      if (q.get("cap")) env.LEAD_NOTIFY_HOURLY_CAP = q.get("cap");
      return res.end(JSON.stringify({ ...scenario, resend: resend.mode, cap: env.LEAD_NOTIFY_HOURLY_CAP }));
    }
    if (url.pathname === "/functions/v1/smooth-action") {
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
      });
      const response = await handlers[scenario.fn](request, { env: (k) => env[k], fetch: labFetch });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    if (url.pathname === "/functions/v1/stripe-webhook") {
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
      });
      const response = await stripeWebhook(request, { env: (k) => env[k], fetch });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      if (req.method === "OPTIONS") {
        res.writeHead(204, restCors);
        return res.end();
      }
      const headers = { ...req.headers };
      delete headers.host;
      delete headers["content-length"];
      delete headers.origin;
      const upstream = await fetch(RESTS[scenario.db] + url.pathname.slice("/rest/v1".length) + url.search, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
      });
      const range = upstream.headers.get("content-range");
      res.writeHead(upstream.status, {
        ...restCors,
        "content-type": upstream.headers.get("content-type") || "application/json",
        ...(range ? { "content-range": range } : {}),
      });
      return res.end(Buffer.from(await upstream.arrayBuffer()));
    }
    res.writeHead(404);
    res.end("no encontrado");
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
}).listen(PORT, "127.0.0.1");

const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
for (const site of SITES) {
  http.createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.endsWith("/supabase-config.js")) {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(`window.LEGAL_PREVENT_SUPABASE = { url: "${BASE}", anonKey: "${ANON}" };`);
    }
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(site.dir, path));
    if (!file.startsWith(site.dir)) {
      res.writeHead(403);
      return res.end();
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("no encontrado");
    }
  }).listen(site.port, "127.0.0.1");
}

console.log(`gateway listo en ${BASE}` + (SITES.length ? `; webs: ${SITES.map((s) => `http://127.0.0.1:${s.port}`).join(", ")}` : ""));
