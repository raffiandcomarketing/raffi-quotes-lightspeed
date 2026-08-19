// qm-state: shared app state document with optimistic concurrency (anon JWT required)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, CORS, json } from "./common.ts";

const DOC_ID = "default";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const sb = admin();
  if (req.method === "GET") {
    const { data } = await sb.from("qm_app_state").select("doc,version,updated_at,updated_by").eq("id", DOC_ID).maybeSingle();
    return json({ ok: true, exists: !!data, doc: data?.doc ?? null, version: data?.version ?? 0, updated_at: data?.updated_at ?? null, updated_by: data?.updated_by ?? null });
  }
  if (req.method === "PUT" || req.method === "POST") {
    let body: { doc?: unknown; base_version?: number; user?: string; force?: boolean };
    try { body = await req.json(); } catch (_e) { return json({ error: "invalid JSON" }, 400); }
    if (!body.doc || typeof body.doc !== "object") return json({ error: "doc required" }, 400);
    const size = JSON.stringify(body.doc).length;
    if (size > 6_000_000) return json({ error: "doc too large", size }, 413);
    const { data: cur } = await sb.from("qm_app_state").select("version").eq("id", DOC_ID).maybeSingle();
    const curV = cur?.version ?? 0;
    const base = Number(body.base_version ?? 0);
    if (cur && !body.force && base !== curV) {
      const { data: full } = await sb.from("qm_app_state").select("doc,version,updated_at,updated_by").eq("id", DOC_ID).maybeSingle();
      return json({ ok: false, conflict: true, version: full?.version, doc: full?.doc, updated_at: full?.updated_at, updated_by: full?.updated_by }, 409);
    }
    const next = curV + 1;
    const row = { id: DOC_ID, doc: body.doc, version: next, updated_at: new Date().toISOString(), updated_by: (body.user || "").slice(0, 80) || null };
    const { error } = cur ? await sb.from("qm_app_state").update(row).eq("id", DOC_ID).eq("version", curV) : await sb.from("qm_app_state").insert(row);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, version: next, updated_at: row.updated_at });
  }
  return json({ error: "method not allowed" }, 405);
});
