// lightspeed-api: authenticated (anon JWT) proxy to the connected TEST store with path allow-list + idempotent replay
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, ALLOWED_PREFIX, CORS, getConnection, json, lsFetch } from "./common.ts";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT"]);
const ALLOWED_PATHS = [
  "/api/2.0/retailer", "/api/2.0/outlets", "/api/2.0/registers", "/api/2.0/users", "/api/2.0/taxes", "/api/2.0/payment_types",
  "/api/2.0/customers", "/api/2.0/products", "/api/2.0/search", "/api/2.0/sales", "/api/2.0/brands", "/api/2.0/inventory",
  "/api/2.0/webhooks", "/api/2.0/customer_groups", "/api/2.0/product_types",
  "/api/2026-07/retailer", "/api/2026-07/sales", "/api/2026-07/products", "/api/2026-07/customers", "/api/2026-07/services",
  "/api/2026-07/service_items", "/api/2026-07/payment_types", "/api/2026-07/serial_numbers",
];
const DENY_RE = /(\.\.|%2e%2e|\/api\/1\.0\/token)/i;

function pathAllowed(p: string) {
  if (!p.startsWith("/api/") || DENY_RE.test(p)) return false;
  return ALLOWED_PATHS.some((a) => p === a || p.startsWith(a + "/") || p.startsWith(a + "?"));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const t0 = Date.now();
  let body: { op_id?: string; method?: string; path?: string; body?: unknown; qm_user?: string; meta?: Record<string, unknown> };
  try { body = await req.json(); } catch (_e) { return json({ error: "invalid JSON" }, 400); }
  const method = String(body.method || "GET").toUpperCase();
  const path = String(body.path || "");
  const opId = body.op_id ? String(body.op_id).slice(0, 120) : null;
  if (!ALLOWED_METHODS.has(method)) return json({ error: "method not allowed", method }, 405);
  if (!pathAllowed(path)) return json({ error: "path not allowed by proxy allow-list", path }, 403);

  const sb = admin();
  // idempotent replay for mutating calls
  if (opId && method !== "GET") {
    const { data: prev } = await sb.from("ls_ops").select("http_status,response").eq("op_id", opId).maybeSingle();
    if (prev) return json({ status: prev.http_status, data: prev.response, replayed: true }, 200, { "x-replayed": "true" });
  }
  let conn = await getConnection(sb, ALLOWED_PREFIX);
  if (!conn || !conn.access_token) return json({ error: "not_connected", message: "Lightspeed is not connected. Install/authorize the app first." }, 409);

  let status = 0, data: unknown = null, errText: string | null = null;
  try {
    const r = await lsFetch(sb, conn, method, path, body.body);
    status = r.status; data = r.json ?? { raw: r.text.slice(0, 2000) }; conn = r.conn;
    if (status >= 400) errText = (r.text || "").slice(0, 500);
  } catch (e) {
    status = 0; errText = String((e as Error).message || e);
  }
  const dur = Date.now() - t0;
  await sb.from("ls_request_log").insert({ source: "api", op: opId || (body.meta?.op as string) || null, method, path: path.slice(0, 500), http_status: status || null, ok: status >= 200 && status < 300, duration_ms: dur, error: errText, meta: { qm_user: body.qm_user || null, ...(body.meta || {}) } });
  await sb.from("ls_connections").update({ last_api_request_at: new Date().toISOString(), last_api_request_op: (method + " " + path).slice(0, 200) }).eq("id", conn.id);

  // mirror sales for reconciliation (best effort)
  try {
    const isSale = /^\/api\/2026-07\/sales(\/|$)/.test(path) && method !== "GET" && status >= 200 && status < 300;
    const d = (data as { data?: Record<string, unknown> })?.data;
    if (isSale && d && typeof d === "object" && d.id) {
      const totals = (d.totals || {}) as Record<string, number>;
      const src = (d.source || {}) as Record<string, unknown>;
      const author = (src.author || {}) as Record<string, string>;
      await sb.from("ls_sales").upsert({
        id: d.id as string, source_id: (body.meta?.source_id as string) || null, app_order_number: (body.meta?.order_number as string) || null,
        app_quote_number: (body.meta?.quote_number as string) || null, state: d.state as string, invoice_number: d.invoice_number as string,
        total: totals.price_incl_tax ?? totals.price ?? null, total_tax: totals.tax ?? null, customer_id: (d.customer_id as string) || null,
        salesperson_user_id: author.id || null, outlet_id: (src.outlet_id as string) || null, register_id: (src.register_id as string) || null,
        sale_date: (d.date as string) || null, version: null, raw: d, updated_at: new Date().toISOString(),
      }, { onConflict: "id" });
    }
  } catch (_e) { /* ignore mirror errors */ }

  if (opId && method !== "GET" && status > 0) {
    await sb.from("ls_ops").insert({ op_id: opId, action: method + " " + path, request: (body.body ?? null) as unknown as Record<string, unknown>, response: data as Record<string, unknown>, http_status: status });
  }
  if (status === 0) return json({ status: 0, error: errText || "network error" }, 502);
  return json({ status, data, replayed: false });
});
