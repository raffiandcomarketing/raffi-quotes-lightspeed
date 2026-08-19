# QA findings log (running) — Raffi Quotes & Invoicing DEV vs Lightspeed X-Series test store

Store: developerdemoxeqwzt.retail.lightspeed.app (retailer 02a1177e-2397-11f1-ecbf-9b334c2b1140, "Developer Demo xeqwzt", trialing, expires Sep 17 2026)
Access method for native experiments: logged-in browser session (cookie + X-XSRF-TOKEN) hitting /api/2.0, /api/2026-07 — no production account touched.

## Phase 1 (static review of QuoteMachine App.html)
- Single-file HTML/vanilla JS, 164,888 bytes, 1,393 lines. Persistence: window.storage (Claude artifact API) only; otherwise in-memory. NO localStorage, NO backend, NO Lightspeed API/OAuth/webhooks/fetch anywhere.
- Data model: settings, counters, contacts, products, quotes(status draft/open/accepted/declined; templates), orders(open/completed/cancelled; free dropdown, unguarded), invoices (status derived: open/partial/paid/overdue), payments (invoice-only), activity.
- Deposits: no concept. Only "Record payment" on an invoice; a partial payment = "Partially paid" invoice. Quotes/orders cannot take deposits.
- Tax: single global rate on taxable lines, discount before tax; computed at render, never stored.
- Attribution: settings.user free text; no auth/roles; activity feed only.
- No idempotency, no retries, no error handling (no I/O), invoices with payments deletable (audit loss), contacts deletable leaving orphan docs.
- Every "transaction point" is local; zero Lightspeed writes. => Installing this file into Lightspeed cannot move any money/sales into Lightspeed.

## Phase 2 (dev portal + store)
- Dev portal app: "Raffi Quotes & Invoicing - DEV", client_id iCNOx9l9Ly82LNvQCBjxKvb2138woXQF, redirect https://hjcgqxszwqmzirtlaxze.supabase.co/functions/v1/lightspeed-oauth/callback, connections 0.
- Supabase project raffi-quotes-lightspeed (hjcgqxszwqmzirtlaxze): schema from Aug 7 (ls_connections, ls_oauth_states, ls_config, mirrors, ls_sales w/ source_id unique, ls_webhook_events dedupe_key, ls_request_log, vault get/set fns) — 0 rows, NO edge functions deployed, NO vault secrets. Project was paused (free tier); restored today.
- => Install fails today: redirect target does not exist. Root cause: backend never deployed (app bug / incomplete build), not Lightspeed.
- Store config found: 1 outlet/1 register/1 user, taxes GST 15% (NZ template!) + No Tax, payment types Cash + Store Credit only, tax-INCLUSIVE, market NZ, currency CAD, tz Toronto. Lightspeed Payments NOT available (NZ market) -> Moneris/Square/Windcave/Chase available (iPad SDK) but untestable without hardware.
- Config applied for QA: outlets Cambridge (renamed), Waterloo, Montréal – TUDOR Royalmount (+registers via UI; API cannot create registers), taxes HST 13% (default), GST 5%, QST 9.975%, GST+QST 14.975% (single-rate approximation; group tax needs UI), payment types Credit Card / Debit Card / E-transfer / Moneris Terminal (manual) [type 3 "Other"], tax-exclusive display ON. Note: retailer settings UI shows "Unable to update settings" although the change is applied (GraphQL response unmarshal bug: display_retail_price_tax_inclusive number->bool) — Lightspeed UI bug.
- Outlet default_tax_id cannot be set per outlet via API 2.0 PUT (ignored) — retailer default applies; Montréal GST+QST must be set per line by the app.
- QA data: customer QA SERVICE TEST CUSTOMER (QA-CUST-001, 0285f360-5424-11f1-f6e2-9b3ff88c9b2d); products QA-WATCH-001 ($10,000, tracked, 1 @Cambridge), QA-JEWELLERY-001 ($1,250, 2 @Cam 1 @Wat), QA-PART-001 ($12, 5 each), QA-SERVICE-001 ($2,000 taxable, non-inventory), QA-SERVICE-002 ($2,000 non-taxable), QA-SERVICE-003 ($10,000), QA-DEPOSIT ($0 variable), QA-ROLEX-001 ($15,000, brand QA Rolex, 1 @Montréal). Users cannot be created via API (UI only).

## Phase 4–7 native Lightspeed experiments (versioned API /api/2026-07/sales)
T-LAYBY-1 (sale 7adcf76a…, receipt 1): state pending + attributes ["layby"], $2,000 non-taxable, $500 cash.
  - API: status LAYBY, totals 2000, payments [500 cash]. Client-provided sale id honoured (idempotent create).
  - Retail dashboard: Revenue $0, sale count 0. Sales report (summary): Revenue $0.00. Payment report: Cash $500. Tax report: nothing.
  - Register closure (open): "New sales $2,000 — Layby $2,000"; "Payments $500 — Layby $500"; Cash expected 500; sections "Laybys started $2,000" and "Layby payments $500".
  - Customer balance: 0 (layby does not create A/R balance).
  +$300 Credit Card via PUT (full payload, existing payments with ids): payments 500+300, still LAYBY. Original payment timestamps retained.
  RETRY TEST: re-sending a payment WITHOUT a client id => Lightspeed appended a duplicate $300 (append-only payments; omitted existing payments are NOT deleted). Reversal via negative payment (-300 Credit Card) works. Payment with client-generated UUID id => retry with same id does NOT duplicate. => App MUST send client-generated payment ids (idempotency key) and never resend un-identified payments.
  Final $1,200 cash + state closed => status LAYBY_CLOSED. Paid = 2,000. Sales report Revenue $2,000 (once). Register closure Payments $2,000 (Cash 1,700, Card 300). Reconciliation OK: value 2,000 / cash 2,000 / recognized 2,000 / duplicate 0.
T-ONACCT-1: attributes ["onaccount"], $2,000, $500 cash => status ONACCOUNT; Sales report Revenue +$2,000 IMMEDIATELY (recognized at creation, only $500 paid) => NOT acceptable for deposits.
T-PARKED-1: state parked with a $500 payment => status SAVED; API accepted the payment (UI never allows this). Not in revenue; the $500 shows in cash expected but not in "Payments" summary => closure discrepancy. Do not use.
T-CLOSED-DEP: closed sale of $500 "deposit" line => Revenue +$500 immediately (the QuoteMachine anti-pattern) => CRITICAL if used for deposits.
T-LAYBY-TAX: $2,000 + HST 13% (2,260) layby, $500 debit => tax NOT in tax report while pending; register closure shows Tax $260 under new laybys.
T-LAYBY-10K: $10,000, $2,500 card => LAYBY, revenue 0, payment 2,500 visible.
T-LAYBY-INV: jewellery on layby (qty 2->1 at Cambridge immediately on layby creation); voided => qty back to 2, status VOIDED, payment record retained on sale but removed from expected cash and shown as "Voided $200" line in closure.
Native Service Orders module: enabled in store. POST /api/2026-07/services {customer_id, outlet_id, register_id} => job + backing sale (state pending, attributes ["service"], status SERVICE). Adding `item` (customer-owned item) via API => HTTP 500 (both 2.0 and 2026-07) — API defect; no create endpoint for service_items. Service sale with $2,000 line + $500 payment stays SERVICE/pending, NOT in revenue (Sales report unchanged), closure lists it under "New" bucket.
Sales history labels: "Layaway", "Layaway, completed", "On-account", "Parked", "Completed", "Voided", "Service, pending".

## 2026-08-19 — module hosting + UI hosting limitation

- `qm-module` redeployed as a DB-backed server: module JS now lives in `public.qm_module_chunks`
  (6 line-aligned chunks, per-chunk md5/sha verified on insert). `/qm-module/version` reports
  total sha256 `347aece84f764727bf137a97cc208494645f92bac9a93af3d470d253a9d1c8c8` = local
  `app/qm_module.js` — byte-exact. Content-type `application/javascript` survives the platform edge.
  (Root cause of earlier 500s: first deploy attempt corrupted in transcription (base64 embed);
  second attempt used SubtleCrypto MD5, which Deno doesn't support → `NotSupportedError`. Fixed
  by moving the module to DB chunks + sha256-only hashing.)
- **FINDING (hosting-platform limitation, NOT app / NOT Lightspeed):** the shared `*.supabase.co`
  domain rewrites `text/html` responses to `text/plain` (anti-phishing), so `qm-app` (and a `qm`
  re-serving probe) render as source text in the browser. Verified via edge logs
  (`response.headers.content_type: text/plain` despite the function setting `text/html`) and
  matching community reports (supabase discussions #35627, #39110 — custom domains unaffected).
  Decision: host the UI page on GitHub Pages from the project repo; keep module + JSON APIs on
  Supabase (unaffected). `qm-app/version` remains the page-bytes integrity check.
- GitHub project created by Al: `raffiandcomarketing/raffi-quotes-lightspeed` (private). Container
  git/API access is repo-bound and this repo isn't bound → pushed via GitHub web upload from the
  browser instead.
