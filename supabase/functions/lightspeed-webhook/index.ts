// lightspeed-webhook: receives X-Series webhooks (form-encoded payload=<json>), dedupes, stores for reconciliation
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, ALLOWED_PREFIX, CORS, json } from "./common.ts";

async function hmacValid(secret: string, raw: string, sigHeader: string | null): Promise<boolean> {
  if (!secret || !sigHeader) return false;
  // X-Signature: signature=<hex>,algorithm=HMAC-SHA256
  const m = /signature=([a-f0-9]+)/i.exec(sigHeader);
  if (!m) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === m[1].toLowerCase();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: true, note: "webhook endpoint" });
  const raw = await req.text();
  const sb = admin();
  let payloadStr = raw, type = "unknown", prefix: string | null = null, retailerId: string | null = null;
  try {
    const params = new URLSearchParams(raw);
    if (params.has("payload")) { payloadStr = params.get("payload") || ""; type = params.get("type") || type; prefix = params.get("domain_prefix"); retailerId = params.get("retailer_id"); }
  } catch (_e) { /* raw json */ }
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(payloadStr); } catch (_e) { payload = { raw: payloadStr.slice(0, 4000) }; }
  const secret = Deno.env.get("LS_WEBHOOK_SECRET") || "";
  const sigValid = secret ? await hmacValid(secret, raw, req.headers.get("x-signature")) : null;
  if (prefix && prefix.toLowerCase() !== ALLOWED_PREFIX) {
    return json({ ok: false, ignored: "store not allowed" }, 202);
  }
  const id = (payload.id as string) || "";
  const version = (payload.version as number | string) || (payload.updated_at as string) || "";
  const dedupe = `${type}:${id}:${version}`;
  const { error } = await sb.from("ls_webhook_events").insert({ dedupe_key: dedupe, webhook_type: type, domain_prefix: prefix, payload, signature_valid: sigValid, process_status: "received" });
  if (error && /duplicate|unique/i.test(error.message)) {
    await sb.from("ls_webhook_events").update({ process_note: "duplicate delivery ignored", processed_at: new Date().toISOString() }).eq("dedupe_key", dedupe);
    return json({ ok: true, duplicate: true });
  }
  if (error) return json({ ok: false, error: error.message }, 500);
  // mirror sale snapshot when a sale webhook arrives
  if (/sale/i.test(type) && id) {
    const totals = (payload.totals || {}) as Record<string, number>;
    await sb.from("ls_sales").upsert({ id, state: (payload.state as string) || (payload.status as string) || null, invoice_number: (payload.invoice_number as string) || null, total: totals.price_incl_tax ?? totals.price ?? (payload.total_price_incl as number) ?? null, total_tax: totals.tax ?? (payload.total_tax as number) ?? null, customer_id: (payload.customer_id as string) || null, raw: payload, updated_at: new Date().toISOString() }, { onConflict: "id" });
  }
  await sb.from("ls_connections").update({ last_webhook_at: new Date().toISOString() }).eq("domain_prefix", ALLOWED_PREFIX);
  return json({ ok: true, duplicate: false, retailer_id: retailerId });
});
