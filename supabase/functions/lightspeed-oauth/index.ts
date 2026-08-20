// lightspeed-oauth: OAuth 2.0 start / callback / status for Raffi Quotes & Invoicing – DEV (test store lock)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, ALLOWED_PREFIX, CORS, DEFAULT_API_VERSION, getClientSecret, html, json, LS_CLIENT_ID, SCOPES } from "./common.ts";

const PAGE = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f4f0;color:#27303c;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#fff;border:1px solid #e6e1d6;border-radius:12px;padding:28px 32px;max-width:560px;box-shadow:0 8px 30px rgba(11,32,63,.08)}h1{font-size:20px;margin:0 0 10px;color:#0b203f}p{line-height:1.5}code{background:#f1eee7;padding:2px 6px;border-radius:4px}a.btn{display:inline-block;margin-top:14px;background:#0b203f;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none}</style></head>
<body><div class="card"><h1>${title}</h1>${body}</div></body></html>`;

function redirectUri(req: Request) {
  const u = new URL(req.url);
  // Supabase functions are reachable at /functions/v1/<name>; keep exact registered redirect.
  // Behind the platform proxy req.url reports http:// — force https so the redirect_uri
  // matches the https URI registered in the Lightspeed developer portal (exact-match check).
  return `https://${u.host}/functions/v1/lightspeed-oauth/callback`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const sub = url.pathname.replace(/^.*\/lightspeed-oauth/, "") || "/";
  const sb = admin();

  if (sub === "/" || sub === "/status") {
    const { data } = await sb.from("ls_connections").select("domain_prefix,retailer_id,retailer_name,status,connected_at,token_expires_at,scopes,api_version,last_api_request_at,last_api_request_op,disconnected_at").eq("domain_prefix", ALLOWED_PREFIX).maybeSingle();
    const secret = await getClientSecret(sb);
    return json({ ok: true, allowed_domain_prefix: ALLOWED_PREFIX, client_id: LS_CLIENT_ID, secret_configured: !!secret, scopes_requested: SCOPES, connection: data || null, connected: !!(data && data.status === "connected") });
  }

  if (sub === "/start") {
    const secret = await getClientSecret(sb);
    if (!secret) return html(PAGE("Cannot start install", `<p>The backend has no <code>LS_CLIENT_SECRET</code> configured. Add it under Supabase → Edge Functions → Secrets, then retry.</p>`), 500);
    const returnTo = url.searchParams.get("return_to") || "";
    const state = crypto.randomUUID().replace(/-/g, "") + Math.random().toString(36).slice(2, 10);
    const { error } = await sb.from("ls_oauth_states").insert({ state, return_to: returnTo || null });
    if (error) return html(PAGE("Cannot start install", `<p>${error.message}</p>`), 500);
    const authz = new URL("https://secure.retail.lightspeed.app/connect");
    authz.searchParams.set("response_type", "code");
    authz.searchParams.set("client_id", LS_CLIENT_ID);
    authz.searchParams.set("redirect_uri", redirectUri(req));
    authz.searchParams.set("state", state);
    authz.searchParams.set("scope", SCOPES);
    return Response.redirect(authz.toString(), 302);
  }

  if (sub === "/callback") {
    const err = url.searchParams.get("error");
    if (err) return html(PAGE("Authorization declined", `<p>Lightspeed returned <code>${err}</code>. Nothing was connected.</p>`), 400);
    const code = url.searchParams.get("code") || "";
    const prefix = (url.searchParams.get("domain_prefix") || "").toLowerCase();
    const state = url.searchParams.get("state") || "";
    const grantedScope = url.searchParams.get("scope") || "";
    if (!code || !prefix || !state) return html(PAGE("Invalid callback", `<p>Missing code / domain_prefix / state.</p>`), 400);

    // state validation (CSRF + replay)
    const { data: st } = await sb.from("ls_oauth_states").select("*").eq("state", state).maybeSingle();
    if (!st) return html(PAGE("Invalid state", `<p>Unknown or already consumed OAuth state. Start the install again from the app.</p>`), 400);
    if (st.used) return html(PAGE("Replay blocked", `<p>This authorization response was already processed.</p>`), 400);
    if (new Date(st.expires_at).getTime() < Date.now()) return html(PAGE("State expired", `<p>The install link expired (15 min). Start again.</p>`), 400);
    await sb.from("ls_oauth_states").update({ used: true }).eq("state", state);

    // TEST-STORE LOCK
    if (prefix !== ALLOWED_PREFIX) {
      return html(PAGE("Store not allowed", `<p>This DEV backend is locked to the test store <code>${ALLOWED_PREFIX}</code>. The store <code>${prefix}</code> was <b>not</b> connected and no token was stored.</p>`), 403);
    }

    const secret = await getClientSecret(sb);
    if (!secret) return html(PAGE("Backend misconfigured", `<p>LS_CLIENT_SECRET missing.</p>`), 500);
    const form = new URLSearchParams({ code, client_id: LS_CLIENT_ID, client_secret: secret, grant_type: "authorization_code", redirect_uri: redirectUri(req) });
    const tr = await fetch(`https://${prefix}.retail.lightspeed.app/api/1.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    const tok = await tr.json().catch(() => ({}));
    if (!tr.ok || !tok.access_token) {
      await sb.from("ls_request_log").insert({ source: "oauth", op: "token_exchange", method: "POST", path: "/api/1.0/token", http_status: tr.status, ok: false, error: String(tok.error || tok.message || "token exchange failed") });
      return html(PAGE("Token exchange failed", `<p>Lightspeed responded ${tr.status}: <code>${(tok.error || tok.message || "unknown").toString().slice(0, 200)}</code></p>`), 502);
    }
    const exp = tok.expires ? new Date(Number(tok.expires) * 1000) : new Date(Date.now() + (Number(tok.expires_in || 86400) * 1000));
    // fetch retailer identity
    let retailerId: string | null = null, retailerName: string | null = null;
    try {
      const rr = await fetch(`https://${prefix}.retail.lightspeed.app/api/2.0/retailer`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
      const rj = await rr.json();
      retailerId = rj?.data?.id || null; retailerName = rj?.data?.name || null;
    } catch (_e) { /* ignore */ }

    const row = {
      domain_prefix: prefix, retailer_id: retailerId, retailer_name: retailerName, environment: "test",
      access_token: tok.access_token, refresh_token: tok.refresh_token || null, token_expires_at: exp.toISOString(),
      scopes: tok.scope || grantedScope || null, api_version: DEFAULT_API_VERSION, status: "connected",
      connected_at: new Date().toISOString(), disconnected_at: null, updated_at: new Date().toISOString(),
    };
    const { data: existing } = await sb.from("ls_connections").select("id").eq("domain_prefix", prefix).maybeSingle();
    if (existing) await sb.from("ls_connections").update(row).eq("id", existing.id);
    else await sb.from("ls_connections").insert(row);
    await sb.from("ls_request_log").insert({ source: "oauth", op: "connected", method: "POST", path: "/api/1.0/token", http_status: 200, ok: true, meta: { retailer_id: retailerId, retailer_name: retailerName, scopes: row.scopes } });

    const returnTo = st.return_to;
    if (returnTo) {
      const ru = new URL(returnTo);
      ru.searchParams.set("ls_connected", "1"); ru.searchParams.set("store", prefix);
      return Response.redirect(ru.toString(), 302);
    }
    return html(PAGE("Connected", `<p>Store <code>${prefix}</code> (${retailerName || "?"}) is now connected. You can close this tab and return to the app.</p>`));
  }

  if (sub === "/disconnect" && req.method === "POST") {
    await sb.from("ls_connections").update({ status: "disconnected", disconnected_at: new Date().toISOString(), access_token: null, refresh_token: null }).eq("domain_prefix", ALLOWED_PREFIX);
    return json({ ok: true });
  }

  return json({ error: "not found", sub }, 404);
});
