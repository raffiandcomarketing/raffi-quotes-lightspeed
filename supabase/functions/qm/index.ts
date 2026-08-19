// qm: probe/wrapper endpoint. Re-serves the qm-app page bytes with an explicit
// text/html content type. NOTE (documented platform limitation): on the shared
// *.supabase.co domain the platform rewrites text/html responses to text/plain
// (anti-phishing), so this does NOT render in a browser either — the app UI is
// hosted on GitHub Pages instead (see README). Kept for parity/diagnostics:
// /qm/version returns the page byte count + sha256 as fetched from qm-app.
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};
const SELF = Deno.env.get("SUPABASE_URL") || "https://hjcgqxszwqmzirtlaxze.supabase.co";
const APP_SRC = SELF + "/functions/v1/qm-app";
let cached: { bytes: Uint8Array; sha: string; at: number } | null = null;

async function sha256Hex(b: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", b);
  return Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function page(): Promise<{ bytes: Uint8Array; sha: string }> {
  if (cached && Date.now() - cached.at < 60_000) return cached;
  const r = await fetch(APP_SRC, { headers: { "accept": "text/html" } });
  if (!r.ok) throw new Error("qm-app fetch failed: " + r.status);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const sha = await sha256Hex(bytes);
  cached = { bytes, sha, at: Date.now() };
  return cached;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const u = new URL(req.url);
  try {
    const p = await page();
    if (u.pathname.endsWith("/version")) {
      return new Response(JSON.stringify({ fn: "qm", source: APP_SRC, bytes: p.bytes.length, sha256: p.sha }), {
        headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    return new Response(p.bytes, {
      headers: {
        ...CORS,
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "etag": '"' + p.sha + '"',
        "x-qm-sha256": p.sha,
      },
    });
  } catch (e) {
    return new Response("app unavailable: " + (e as Error).message, { status: 502, headers: { ...CORS, "content-type": "text/plain" } });
  }
});
