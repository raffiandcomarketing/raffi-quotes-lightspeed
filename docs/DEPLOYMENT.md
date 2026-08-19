# Deployment & configuration

## Components and live endpoints

| Component | URL |
|---|---|
| App UI (GitHub Pages) | `https://<owner>.github.io/raffi-quotes-lightspeed/app/` |
| App page bytes / hash | `https://hjcgqxszwqmzirtlaxze.supabase.co/functions/v1/qm-app/version` |
| Integration module | `https://hjcgqxszwqmzirtlaxze.supabase.co/functions/v1/qm-module` (+ `/version`) |
| Shared state API | `https://hjcgqxszwqmzirtlaxze.supabase.co/functions/v1/qm-state` |
| Lightspeed proxy | `https://hjcgqxszwqmzirtlaxze.supabase.co/functions/v1/lightspeed-api` |
| OAuth | `https://hjcgqxszwqmzirtlaxze.supabase.co/functions/v1/lightspeed-oauth/{start,callback,status,disconnect}` |
| Webhook sink | `https://hjcgqxszwqmzirtlaxze.supabase.co/functions/v1/lightspeed-webhook` |

## Lightspeed developer portal (app settings)

- Client ID: `iCNOx9l9Ly82LNvQCBjxKvb2138woXQF` (override with `LS_CLIENT_SECRET` env pair)
- Redirect URI must be exactly:
  `https://hjcgqxszwqmzirtlaxze.supabase.co/functions/v1/lightspeed-oauth/callback`
- Test store: `developerdemoxeqwzt` — the backend refuses every other `domain_prefix`
  (`LS_ALLOWED_DOMAIN_PREFIX`), so authorizing from any other store fails closed (403).

## Edge Function secrets (Supabase → Project Settings → Edge Functions)

| Name | Required | Purpose |
|---|---|---|
| `LS_CLIENT_SECRET` | yes (for OAuth) | token exchange + refresh. Fallback: vault via `ls_get_secret('LS_CLIENT_SECRET')` |
| `LS_CLIENT_ID` | no | defaults to the DEV portal app id |
| `LS_ALLOWED_DOMAIN_PREFIX` | no | defaults to `developerdemoxeqwzt` (test-store hard lock) |
| `LS_API_VERSION` | no | defaults to `2026-07` |
| `LS_WEBHOOK_SECRET` | no | enables HMAC validation on webhook sink |

## verify_jwt matrix

| Function | verify_jwt | Why |
|---|---|---|
| `qm-state`, `lightspeed-api` | true | called from the app with the anon key |
| `lightspeed-oauth` | false | browser redirects (no headers possible) |
| `lightspeed-webhook` | false | Lightspeed posts form-encoded payloads |
| `qm-app`, `qm-module`, `qm` | false | plain asset serving |

## Install / authorize flow (test store)

1. Set `LS_CLIENT_SECRET`.
2. Open the app → Settings → Lightspeed → **Connect / install app**
   (`/lightspeed-oauth/start?return_to=<app url>`).
3. Sign in / pick **developerdemoxeqwzt** → Allow. Callback validates `state`
   (single-use, 15-min expiry), enforces the store lock, exchanges the code at
   `https://developerdemoxeqwzt.retail.lightspeed.app/api/1.0/token`, stores tokens in
   `ls_connections`, fetches `/api/2.0/retailer`, and bounces back to the app with
   `?ls_connected=1`.
4. In the app: **Sync reference data** (outlets/registers/users/taxes/payment types →
   auto-maps locations, payment methods, users; ensures the `QM-SERVICE` generic product).
5. Verify status anytime: `GET /lightspeed-oauth/status` →
   `{connected, secret_configured, connection:{domain_prefix, retailer_name, scopes, token_expires_at}}`.

## Platform limitation (documented)

`*.supabase.co` rewrites `text/html` → `text/plain` at the edge (anti-phishing on the
shared domain), so HTML cannot render from edge functions without a custom domain.
JSON and `application/javascript` responses are unaffected. Hence: UI on GitHub Pages,
module + APIs on Supabase. A Supabase custom domain would also lift this, if ever wanted.

## Verification quick checks

- `qm-app/version` → `{build, bytes, sha256}` (page bytes)
- `qm-module/version` → `{bytes, sha256, chunks[]}` — must equal
  `python3 scripts/build_module_chunks.py --check` output
- `lightspeed-oauth/status` → `secret_configured` / `connected`
- App boot: dashboard shows the liability metric cards; Settings shows the Lightspeed
  card with live status; payments view shows the reconciliation table.
