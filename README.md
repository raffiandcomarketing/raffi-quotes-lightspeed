# Raffi Quotes & Invoicing — Lightspeed X-Series (DEV)

Service-order, quoting and invoicing app for Raffi Jewellers, integrated with the
**Lightspeed X-Series developer test store** (`developerdemoxeqwzt.retail.lightspeed.app`).
This is the QA/DEV build — the backend is **hard-locked to the test store** and refuses
any other `domain_prefix`. Nothing here touches production.

## The accounting rule this app enforces

> **A service deposit is NEVER a sale.** Every deposit or partial payment posts to
> Lightspeed as a **layaway (LAYBY) payment** on a layaway sale — held as *unearned
> revenue* (a liability). The sale is closed — and revenue recognised — **only when the
> service is completed and the balance is $0**. Cancellations either refund (negative
> payment, sale closed at $0 / voided) or retain a cancellation fee (recognised at close).

Verified against native Lightspeed behaviour by experiment: layby payments do not appear
in sales/revenue totals until the sale is closed; on-account sales recognise immediately
(which is why on-account is NOT used for deposits).

## Architecture

```
Browser (app/index.html + app/qm_module.js)
   │  anon key, CORS
   ▼
Supabase Edge Functions (project hjcgqxszwqmzirtlaxze, ca-central-1)
   ├─ qm-state           shared app document, optimistic concurrency (version + 409 conflict)
   ├─ lightspeed-api     allow-listed proxy → Lightspeed API (idempotent op_id replay, request log,
   │                     sales mirror). 409 not_connected when OAuth is missing.
   ├─ lightspeed-oauth   /start /callback /status /disconnect — OAuth 2.0 against
   │                     secure.retail.lightspeed.app; state row + replay/expiry checks;
   │                     hard test-store lock; tokens live in ls_connections (RLS: no anon access)
   ├─ lightspeed-webhook HMAC-optional webhook sink with dedupe (ls_webhook_events)
   ├─ qm-app             serves the app page bytes (gzip+base64 embedded; /version = sha256)
   ├─ qm-module          serves app/qm_module.js from DB chunks (qm_module_chunks; /version = sha256)
   └─ qm                 diagnostic re-serve of qm-app (see platform limitation below)
   ▼
Lightspeed X-Series API — /api/2.0/* + /api/2026-07/sales (client-generated sale & payment
UUIDs → idempotent create/update; payments append-only; negative payments = refunds)
```

State: quotes/estimates never touch Lightspeed. Converting an estimate to a **service
order** and taking the **first deposit** creates the LAYBY sale. Everything (deposits,
refunds, line edits while open, completion→`closed`, cancellation→fee/`voided`) reuses
the same sale id.

## Hosting the UI (why GitHub Pages)

The shared `*.supabase.co` domain rewrites `text/html` responses to `text/plain`
(platform anti-phishing measure), so the app page cannot render from the edge function
directly. The page bytes and hashes stay verifiable at `/functions/v1/qm-app/version`,
but the **served UI lives on GitHub Pages** from this repo (`app/index.html`, which loads
`./qm_module.js` and falls back to the Supabase-hosted module). JSON/JS endpoints are
unaffected. Classification: hosting-platform limitation, not an app or Lightspeed issue.

## Repo layout

| Path | What it is |
|---|---|
| `app/index.html` | The app (original page + Lightspeed integration module, relative load) |
| `app/qm_module.js` | Integration layer: roles/PIN switch, audit log, deposits→LAYBY, refunds, cancel/complete flows, brand/location hard blocks, inventory picker, reconciliation report, settings/mappings, server-state persistence |
| `app/original/baseline_pre_integration.html` | Pre-integration baseline of the single-file app (reference only, not served) |
| `supabase/functions/*` | Edge functions as deployed (each folder self-contained; `_shared/common.ts` is the source of truth, copied per function) |
| `sql/schema.sql` | Full DB schema + RLS as live |
| `scripts/build_module_chunks.py` | Regenerates `sql/load_module_chunks.sql` from `app/qm_module.js` |
| `docs/findings_log.md` | Running QA findings (Phases 1–22 engagement) |
| `docs/DEPLOYMENT.md` | Secrets, OAuth app config, deploy + verify steps |

## Deploy / update cheat-sheet

1. **Module change:** edit `app/qm_module.js` → `python3 scripts/build_module_chunks.py`
   → run `sql/load_module_chunks.sql` in the Supabase SQL editor → confirm
   `GET /functions/v1/qm-module/version` sha256 matches the script output. (No function
   redeploy needed.)
2. **Page change:** edit `app/index.html` → commit (Pages serves it) → optionally
   re-embed into `supabase/functions/qm-app/index.ts` (gzip+base64) for hash parity.
3. **Function change:** deploy the folder under `supabase/functions/<name>` (MCP deploy
   or `supabase functions deploy <name>`; `verify_jwt=false` only for
   `lightspeed-oauth`, `lightspeed-webhook`, `qm-app`, `qm-module`, `qm`).
4. **Secrets:** `LS_CLIENT_SECRET` (required for OAuth), optional `LS_WEBHOOK_SECRET`,
   `LS_CLIENT_ID`, `LS_ALLOWED_DOMAIN_PREFIX`, `LS_API_VERSION` — Edge Function secrets.

## Safety rails

The backend rejects any store but the test store; sale/payment ids are client-generated
UUIDs (safe retries, no duplicate payments); mutating calls replay via `op_id`
(`ls_ops`); deposits can never exceed the remaining balance; completed/cancelled orders
are terminal; deletion is blocked once a Lightspeed sale or payment exists; role
permissions gate refunds/cancel/void/settings; every sensitive action lands in the audit
log. Anyone with the app URL can use the app (single anon key) — acceptable for the DEV
build, flagged in the QA report for production hardening.
