// Shared helpers for Raffi Quotes & Invoicing – DEV ↔ Lightspeed X-Series (test store only)
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export const LS_CLIENT_ID = Deno.env.get("LS_CLIENT_ID") || "iCNOx9l9Ly82LNvQCBjxKvb2138woXQF";
// HARD LOCK: this backend may only ever talk to the developer test store. Production prefixes are rejected.
export const ALLOWED_PREFIX = (Deno.env.get("LS_ALLOWED_DOMAIN_PREFIX") || "developerdemoxeqwzt").toLowerCase();
export const DEFAULT_API_VERSION = Deno.env.get("LS_API_VERSION") || "2026-07";
export const SCOPES = [
  "retailer:read", "outlets:read", "registers:read", "users:read", "taxes:read", "payment_types:read",
  "customers:read", "customers:write", "products:read", "products:write", "inventory:read",
  "sales:read", "sales:write", "payments:read", "serial_numbers:read", "services:read", "services:write", "webhooks",
].join(" ");

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-op-id, x-qm-user",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS, ...extra } });
}
export function html(body: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
}

export function admin(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function getClientSecret(sb: SupabaseClient): Promise<string | null> {
  const env = Deno.env.get("LS_CLIENT_SECRET");
  if (env && env.trim()) return env.trim();
  try {
    const { data, error } = await sb.rpc("ls_get_secret", { p_name: "LS_CLIENT_SECRET" });
    if (!error && data) return String(data);
  } catch (_e) { /* ignore */ }
  return null;
}

export type Conn = {
  id: string; domain_prefix: string; retailer_id: string | null; retailer_name: string | null;
  access_token: string | null; refresh_token: string | null; token_expires_at: string | null;
  scopes: string | null; api_version: string; status: string;
};

export async function getConnection(sb: SupabaseClient, prefix = ALLOWED_PREFIX): Promise<Conn | null> {
  const { data } = await sb.from("ls_connections").select("*").eq("domain_prefix", prefix).eq("status", "connected").maybeSingle();
  return (data as Conn) || null;
}

export async function refreshToken(sb: SupabaseClient, conn: Conn): Promise<Conn> {
  const secret = await getClientSecret(sb);
  if (!secret) throw new Error("LS_CLIENT_SECRET is not configured");
  const form = new URLSearchParams({ refresh_token: conn.refresh_token || "", client_id: LS_CLIENT_ID, client_secret: secret, grant_type: "refresh_token" });
  const r = await fetch(`https://${conn.domain_prefix}.retail.lightspeed.app/api/1.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new Error("token refresh failed: " + (t.error || r.status));
  const exp = t.expires ? new Date(Number(t.expires) * 1000) : new Date(Date.now() + (Number(t.expires_in || 86400) * 1000));
  const upd = { access_token: t.access_token, refresh_token: t.refresh_token || conn.refresh_token, token_expires_at: exp.toISOString(), last_refresh_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  await sb.from("ls_connections").update(upd).eq("id", conn.id);
  return { ...conn, ...upd } as Conn;
}

export async function lsFetch(sb: SupabaseClient, conn: Conn, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; text: string; conn: Conn }> {
  const needsRefresh = !conn.token_expires_at || (new Date(conn.token_expires_at).getTime() - Date.now() < 5 * 60 * 1000);
  if (needsRefresh && conn.refresh_token) conn = await refreshToken(sb, conn);
  const doCall = async (c: Conn) => fetch(`https://${c.domain_prefix}.retail.lightspeed.app${path}`, {
    method, headers: { Authorization: `Bearer ${c.access_token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let r = await doCall(conn);
  if (r.status === 401 && conn.refresh_token) { conn = await refreshToken(sb, conn); r = await doCall(conn); }
  const text = await r.text();
  let j: unknown = null; try { j = JSON.parse(text); } catch (_e) { j = null; }
  return { status: r.status, json: j, text, conn };
}
