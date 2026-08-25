# QA findings log (running) — Raffi Quotes & Invoicing DEV vs Lightspeed X-Series test store

Store: developerdemoxeqwzt.retail.lightspeed.app (retailer 02a1177e-2397-11f1-ecbf-9b334c2b1140, "Developer Demo xeqwzt", trialing, expires Sep 17 2026)
Access method for native experiments: logged-in browser session (cookie + X-XSRF-TOKEN) hitting /api/2.0, /api/2026-07 — no production account touched.

## Phase 1 (static review of the prior single-file app)
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
T-CLOSED-DEP: closed sale of $500 "deposit" line => Revenue +$500 immediately (the deposit-as-revenue anti-pattern) => CRITICAL if used for deposits.
T-LAYBY-TAX: $2,000 + HST 13% (2,260) layby, $500 debit => tax NOT in tax report while pending; register closure shows Tax $260 under new laybys.
T-LAYBY-10K: $10,000, $2,500 card => LAYBY, revenue 0, payment 2,500 visible.
T-LAYBY-INV: jewellery on layby (qty 2->1 at Cambridge immediately on layby creation); voided => qty back to 2, status VOIDED, payment record retained on sale but removed from expected cash and shown as "Voided $200" line in closure.
Native Service Orders module: enabled in store. POST /api/2026-07/services {customer_id, outlet_id, register_id} => job + backing sale (state pending, attributes ["service"], status SERVICE). Adding `item` (customer-owned item) via API => HTTP 500 (both 2.0 and 2026-07) — API defect; no create endpoint for service_items. Service sale with $2,000 line + $500 payment stays SERVICE/pending, NOT in revenue (Sales report unchanged), closure lists it under "New" bucket.
Sales history labels: "Layaway", "Layaway, completed", "On-account", "Parked", "Completed", "Voided", "Service, pending".

## 2026-08-19 (cont.) — GitHub project + hosting
- Repo raffiandcomarketing/raffi-quotes-lightspeed populated via GitHub web upload (13 upload commits + README init; container git creds are bound to other repos). Tree: README, .gitignore, app/{index.html,raffi_module.js,original/}, supabase/functions/{_shared,lightspeed-oauth,lightspeed-api,lightspeed-webhook,raffi-state,raffi-module,+2 retired}, sql/schema.sql, scripts/build_module_chunks.py, docs/{findings_log.md,DEPLOYMENT.md}.
- Al approved: repo public + GitHub Pages; visibility flip pending GitHub sudo-mode email verification (only Al can complete).
- LS_CLIENT_SECRET: walkthrough sent to Al (LS dev portal → Supabase Edge Function secrets).

## 2026-08-20 — Pages live, app boots, OAuth bug fix
- Repo made public by Al; GitHub Pages enabled (main / root). App UI live at
  https://raffiandcomarketing.github.io/raffi-quotes-lightspeed/app/ — boots clean (no console errors),
  module active (liability/balance/revenue/LS cards, user switcher), migration applied, shared server
  state now persisting (raffi-state doc v1).
- LS_CLIENT_SECRET set by Al; /lightspeed-oauth/status → secret_configured true.
- **BUG FOUND & FIXED (app bug, backend): OAuth redirect_uri generated as http:// because the edge
  function sees itself as http behind the Supabase proxy. Lightspeed registered redirect is https —
  exact-match would fail the authorize/token exchange. Fix: force https in redirectUri(). Deployed
  lightspeed-oauth v3; repo copies synced.** Found in Phase 3 (install/authorize) testing.
- OAuth flow reaches secure.retail.lightspeed.app sign-in (Al's store-subdomain session doesn't carry
  over); waiting for Al to sign in, then restarting Connect with a fresh state.

## 2026-08-20 — INSTALL COMPLETE + GOLDEN PATH PASS (Phases 1–5, 8, 14 core)
- OAuth install completed on test store (had to relaunch consent via the STORE-domain /connect route —
  secure.retail.lightspeed.app sign-in wall + first state expired at 15 min, replay guard worked as designed).
  ls_connections: developerdemoxeqwzt "Developer Demo xeqwzt", connected, full scopes, token exp Aug 23.
- Auto syncRef on first connected boot: 3 outlets / 3 registers / 1 user / 6 taxes / 6 payment types;
  all 3 locations mapped w/ correct taxes (HST 13, HST 13, GST+QST 14.975); 8/8 payment methods mapped;
  Al ↔ LS user linked; the legacy service SKU product + No Tax id resolved.
- T-DEP-1 PASS: $20 deposit on ORD-0003 → LS sale created state=pending attrs=["layby"] receipt #16,
  payment posted w/ client UUID (idempotent), customer auto-created (a legacy-prefixed code), native history shows
  "Layaway" NOT a completed sale. Salesperson attribution: Sold by Al Sukara @ Cambridge.
- T-DEP-2 PASS: 2nd deposit $10 → same sale #16, payments [20,10], still open layaway.
- T-OVR-1 PASS: $100 > balance $15.90 → blocked client-side, no payment, no API call.
- T-FIN-1 PASS (via Complete & close button): final $15.90 → balance $0; Complete & close → LS sale
  state=closed (attrs layby), payments [20,10,15.90], app status completed, completedBy stamped,
  INV-0001 auto-created, native history now "Layaway, completed". Liability $0, recognised $45.90.
- MINOR UI BUG (severity LOW): "Complete service & close if pays in full" checkbox in pay modal did not
  register the check on first try (automation click) — close had to run via the Complete & close button
  (which worked). Retest checkbox path on T2; consider larger hit area.
- Evidence: /tmp/claude-chrome-screenshots-SKd2Gl/screenshot-*.jpg (0=layby open history, 1=PAY-0002,
  2=balance 0 still open, 3=app completed, 4=history "Layaway, completed").

## 2026-08-20 — Test battery results (Phases 5–21)
- T2 PASS refund-on-open-layaway: -$20 negative payment on same sale; LS [50,-20] pending/layby; held 30.
- T3 PASS cancel-with-fee: refund -20 then close at $10 fee line; LS closed, payments net = fee = 10; app cancelled, fee recognised.
- T4 PASS cancel-full-refund: LS closed at $0, payments [25,-25] net 0, nothing recognised.
- T5 PASS cancel-net-zero → sale VOIDED (deposit 15, refund 15, cancel).
- T6 PASS roles: associate CAN take deposits; refund/cancel/settings/users DENIED with audit rows; PIN user switch works.
- T7 PASS idempotency: (a) re-send same payment ids → LS payment count unchanged; (b) same op_id POST → replayed:true, no duplicate customer; (c) concurrent double-submit → single payment (withLock).
  * BUG FOUND+FIXED (backend, LOW): proxy forwarded JSON null body on GET → Deno fetch error; only reachable with explicit null (app never sends), fixed by normalizing null→undefined + never forwarding body on GET (lightspeed-api v3). All 6 historical failed requests in ls_request_log are this probe.
  * Note: LS search indexing is eventually consistent (fresh customer not in search seconds after create) — platform behaviour.
- T9 PASS taxes: ON/Cambridge $100 @13% → tax 13 total 113 (LS line tax.amount 13); QC/Montréal $200 @14.975% → tax 29.95 total 229.95 (LS matches). Paid-in-full-not-picked-up stays open layaway (still liability) — correct.
- T8 PASS standalone invoice: Record payment routes to auto-created service order (ORD-0010) + deposit modal (no direct invoice payments).
- T10 PASS restrictions: out-of-stock hard block; brand rule (Rolex→Cambridge only) blocks at Waterloo; per-location allowedBrands blocks; serialized double-allocation across open orders blocked. Real stock probe: QA-PART-001 5@Cambridge.
- T10g PASS inventory: adding QA-PART-001 to layaway deducted stock 5→4 at sale creation (native layby commit).
- T11 PASS delete guards (order w/ sale, linked invoice, contact w/ history all blocked). T13 PASS status transitions (terminal states locked; completed via select requires $0 + confirm; balance-due block works).
- T12 PASS reconciliation: per-order and total identity HOLDS — cash 273.90 = recognised 55.90 + liability 218.00 across 9 orders, 0 violations. DB mirror ls_sales: 8 sales linked to orders; states 3 closed/4 open/1 voided = matches app+LS. 79 API calls, 0 unexpected failures. App cold-booted from server state v49 in a fresh tab (persistence verified).
- Webhooks: registration required `active:true` (422 without — documented API requirement, not a bug); registered sale.update active (201). Delivery is async — nudged sale #21; delivery check pending.

## 2026-08-21 — Change requests (Al) + Special Orders test cycle (T-SO)
Change requests implemented and deployed (module sha 4a20a7ec…, GitHub commits 64c84cd/18df3d6):
1. Sidebar open by default with visible titles (labels from data-tip; collapses to icon rail <900px).
2. Sales now post with attributes ["layby","service"] to match the requested Lightspeed state
   `pending | layby,service` (previously ["layby"] only).
3. NEW "Special Orders" section (gem icon, own list + statuses Ordered/With supplier/Arrived/Picked up),
   `SO-` numbering, capture of brand/model/reference/price/ETA, auto deposit modal on create.
   Rule enforced: deposits (multiple) and even FULL prepayment stay an open layaway
   (`pending · layby,service`); the sale closes (revenue recognised) only at pickup (Complete & close).

- T-SO-1 **BUG FOUND (HIGH) → FIXED → RETESTED**: first special-order deposit taken as "Credit Card"
  posted to Lightspeed as payment type **"Store Credit"** → LS 400 "Can not create sale … ensuring store
  credit customer: store credit customer is not found" (customer had no store-credit account; sale not
  created; app correctly kept the payment local with SYNC FAILED + Retry).
  Root cause: payment-method auto-mapping used `/credit/i`, which matches "Store Credit" before
  "Credit Card" in the store's payment-type list. Same defect mapped "Gift Card" → Store Credit.
  Latent until today because every prior test paid Cash (mapping gap now covered).
  Fix (raffi_module.js syncRef): Store Credit is excluded from auto-mapping entirely (exact-name match first,
  then safe regexes; Gift Card falls back to Cash), plus self-healing — poisoned/stale mappings are
  re-derived on next reference sync. Verified: before {Credit Card→Store Credit, Gift Card→Store Credit}
  → after {Credit Card→Credit Card, Debit→Debit, Gift Card→Cash, Wire→E-transfer (no Wire type in store)}.
  Retest: Retry on PAY-0017 → posted; classification: App bug (2 = app; LS's 400 was correct behaviour).
- T-SO-2 PASS multiple deposits on one special order: $3,000 Credit Card + $5,000 Debit Card on sale
  receipt #26, state pending, attrs ["layby","service"].
- T-SO-3 PASS **full prepayment ≠ sale**: final $7,763.50 (Wire→E-transfer) → balance $0, checkbox off →
  LS sale STILL `pending · layby,service` (to_pay 0), app order stays OPEN; native Sales History shows
  status "Layaway" (not Completed). This is Al's special-order watch scenario verified end-to-end.
- T-SO-4 PASS pickup: Complete & close → LS sale closed (Layaway – completed #26), app status
  Picked up, INV-0004 auto-created, completedBy stamped.
- Reconciliation after cycle: identity HOLDS — cash 16,217.35 = recognised 16,049.35 + liability 168.00,
  0 violations (deposit-as-sale rule intact store-wide).
- Cleanup: 3 diagnostic $1.13 probe sales (receipts 23–25) voided; proxy v4 adds read-only
  /api/2.0/store_credits to the allow-list (diagnostics; GET-only, writes 403).
- Platform notes: LS OAuth token lacks a store-credits scope in this app's grant, so store-credit balances
  are not readable via the proxy (403 upstream). Sales-history UI screenshot: back-office tab renderer
  froze under CDP capture (page text extracted instead) — cosmetic, evidence captured via API + app UI.

## 2026-08-21 (later) — Register "Continue sale" dead-lock: found, fixed, verified
- Al reported: continuing a partially-paid layaway at the LS register raised "If you continue this
  sale, the service on the sale will be completed" and the confirm button did nothing.
- Reproduced (receipt 31): clicking "Complete service and continue" fires NO application request
  (console/network clean) — the register wants to complete a service JOB, but the sale only carries
  the `service` attribute; its Services tab is empty. /api/2026-07/services can't attach a job to an
  existing sale (POST {sale_id} → 500; LS creates its own sale+job pairs), and sale attributes are
  immutable on PUT (returned unchanged). Control test: layby-only receipt 20 continues straight to
  the pay screen.
- Classification: **App bug (2 = ours)** — we set `service` for display parity with the requested
  `pending | layby,service` state without an LS service job behind it. LS behaved consistently.
- Fix: buildSale posts attributes `["layby"]` only (accounting rule fully enforced by layby state;
  service semantics live in-app). Four stuck open sales (receipts 27/28/30/31) were voided with a
  "superseded" note and rebuilt as fresh layby-only sales (33/34/35/36) with all payments carried.
  Verified: receipt 36 (SO-0017) continues straight to Pay $4,300 at the register. ORD-0018's sale,
  briefly re-opened by the bulk re-sync, restored to voided.
- Reconciliation after rebuilds (incl. Al's own live testing, 16 orders/27 payments):
  cash 49,147.35 = recognised 27,349.35 + liability 21,798.00 — identity holds, 0 violations.
- Same deploy: official white Raffi wordmark above the menu at 112px (static, from the site's own
  footer SVG); expanded sidebar + labels now ship in index.html CSS (::after from data-tip) so the
  first paint is correct — the icon-only flash is gone; Special Orders item static in the nav with a
  safe placeholder view pre-module; special orders now post a placeholder line and switch it to
  BRAND MODEL Ref. + S/N at pickup (serial required to close).

## 2026-08-21 (evening) — Register-first deposits (Al's change request) — built & verified E2E
- New flow: the deposit modal's primary action is now **Create layaway — take at register**. The app
  creates/updates the Lightspeed layaway (the "SO") with NO app-recorded payment; the rep collects
  the actual money at the LS register (Continue sale → edit amount for a partial → tender → Layaway).
  The app then imports register payments automatically (diff by LS payment id) into its ledger —
  method + LS tender config preserved, "Processed by: Lightspeed register", sync POSTED — and holds
  them as unearned revenue exactly like app-recorded deposits. Auto-import runs whenever an open
  order is viewed (20s debounce) and on Sync with Lightspeed. "Record payment (outside register)"
  remains for e-transfer/wire/phone money.
- E2E proof (SO-0019, receipt #37): app created unpaid layaway → register took a REAL $2,500 cash
  partial (Pay → edit amount → Cash → Layaway) → sale stayed `pending·layby` with $11,060 to pay →
  reopening the order in the app imported PAY-0028 ($2,500 Cash, Lightspeed register) with toast.
  Reconciliation identity holds: cash 51,647.35 = recognised 27,349.35 + liability 24,298.00, 0 violations.
- Edge handled: if the register takes the FINAL payment, Lightspeed closes the layaway natively; on
  import the app marks the order completed (revenue recognised) — for special orders missing a
  serial it warns that the receipt closed on the placeholder line. Recommended process: partials at
  the register; final payment + Complete & close through the app (or enter the serial first).

## 2026-08-21 (late) — "Special Order Product" line, Raffi ID receive-swap, full-prepayment guard, de-branding, nav order
Build QA-2026-08-21-LS2 · module sha 1707b8c3… (Pages + Supabase chunks byte-identical) · proxy v5.

**Al's requests.** Remove every mention of the prior vendor; a special order must post its Lightspeed
line as **Special Order Product** with **Brand + Model + Reference in the note**, still unearned
revenue; when **inventory receives** the piece the line must switch to the **actual product under
the Raffi ID generated in Salesforce**; Quotes/Orders/Invoices move below Special Orders in the
menu. Mid-build Al hit a real register trap on SO-0022: tendering the FULL amount auto-completes
the sale (Layaway is only offered while a balance remains) — premature revenue.

**Built.**
1. **De-branding** — sale notes now `SO-00xx — Special order: BRAND MODEL Ref. X` / `ORD-00xx —
   <service title>` (no vendor suffix); the generic service product could NOT be renamed
   (2026-07 products PUT rejects name/variant_name/active: "Unknown field in payload" — platform
   limitation), so the app swapped to a clean **Service / labour** product (sku RAFFI-SERVICE),
   re-pointed all open sales on re-sync, and deleted the old vendor-named product (proxy v5
   allows DELETE strictly for /api/2.0/products/{id}; soft delete, receipts unaffected). Import-error
   toast in index.html reworded. Historical closed/voided sales (SO-0012/15, ORD-0004/5/6/9) keep
   their frozen notes — editing closed sales would falsify history.
2. **Special Order Product** — shared LS product (sku SPECIAL-ORDER) used by every special-order
   line while awaiting arrival; legacy specials migrated (flag at boot + lazy flag in buildSale
   after the first migration raced the async db load — fixed).
3. **Receive into inventory** — "Awaiting arrival" banner + Raffi ID field on special orders;
   "Product arrived — enter Raffi ID" find-or-creates the real LS product (**sku = Raffi ID**,
   name = Brand Model Ref) and re-syncs the OPEN layaway — same line id, product swapped, deposits
   still unearned; status → Arrived. Choosing "Arrived" in the status dropdown routes through the
   same modal. Close (pickup) now requires Raffi ID + serial; the closing sale note carries
   `— S/N <serial>`.
4. **Full-prepayment guard** — on sync, a CLOSED sale for an unreceived special triggers automatic
   reopen (PUT state pending; fallback void+rebuild with payments carried). Register walkthrough
   banner explains the full-amount case. SO-0022 ($11,300 CC full tender, register-completed) was
   rescued exactly this way: PUT pending succeeded, payment imported and held as unearned.
5. **Nav** — Special Orders sits above Quotes/Orders/Invoices (static + module fallback).

**E2E verified (TEST store).**
- SO-0022: closed→reopened `pending·layby`, note "SO-0022 — Special order: ROLEX GMT7 Ref.
  TEST7654321", line = Special Order Product → received RAF-10022 (line → product "ROLEX GMT7
  Ref. TEST7654321", sku RAF-10022, still pending) → closed with S/N Z8K334891; $11,300 recognised
  only at pickup.
- SO-0023 (fresh, receipt #41): created clean → $1,500 cash deposit held `pending·layby` under
  Special Order Product → received RAF-10023 → close blocked without serial (negative test passed)
  → final $4,150 + serial closed it; LS receipt shows "CARTIER Santos de Cartier Ref. WSSA0018",
  note "SO-0023 — Special order: … — S/N WS445102". No vendor name anywhere on any open sale.
- Bulk re-sync of 10 open sales to clean products/notes; ORD-0018 (LS-voided, app cache stale) was
  briefly re-opened by the sweep and immediately re-voided + cache fixed — reconfirmed the rule:
  filter bulk syncs by LS truth, not the app cache.
- Reconciliation identity: cash 70,597.35 = recognised 44,299.35 + liability 26,298.00, delta 0.

## 2026-08-21 (later) — Full-prepayment lifecycle demo (Al's request): pay 100% up front, stay on layaway until pickup
- SO-0024 / receipt #42 (Nicole Carmount, OMEGA Speedmaster Professional Ref. 310.30.42.50.01.001,
  $8,000 + HST = $9,040): created → **full $9,040 Credit Card prepayment recorded at creation**
  (complete-checkbox left off) → Lightspeed sale stays **`pending · layby`, Balance $0.00, status
  "Layaway"** — not closed, not revenue → received into inventory (Raffi ID RAF-10024; line swapped
  from Special Order Product to the actual OMEGA, sku RAF-10024) → **still an open layaway at $0
  balance**, app status "Arrived — awaiting pickup". Order intentionally left open as the living
  example; pickup (serial + Complete & close) is what recognises the $9,040.
- Reconciliation identity after the prepayment: cash 79,637.35 = recognised 44,299.35 (unchanged —
  the prepayment added zero revenue) + liability 35,338.00 (up exactly $9,040), delta 0, 0 violations.
- Register-path equivalent verified earlier the same day on SO-0022: full tender auto-completes at
  the register, and the app reopens it as an open layby automatically.

## 2026-08-21 (night) — Al's challenge: "Lightspeed cannot show a completed sale when paid in full" — gap closed
- Confirmed the hole Al spotted: the register FORCE-completes a sale the moment the full amount is
  tendered (Layaway is not offered at $0 balance — platform limitation, cannot be overridden), and
  detection previously ran only when someone opened the order in the app — so a full-tender sale
  could sit in Lightspeed as a completed sale (counted in LS reports) until then.
- Fixes (build sha a3fd3c8b…): (1) **register watcher** — every order awaiting a register payment
  is refreshed in the background every ~25s from ANY screen; a premature close is reopened within
  seconds, no need to open the order; (2) premature-close detection no longer gated on a new
  payment import (runs on every refresh of a closed, unreceived special); (3) guidance updated in
  the walkthrough banner + deposit modal: **full prepayment should go through Record payment
  (outside register)** — the sale then NEVER shows completed at any moment (proven on SO-0024
  receipt #42, "Layaway" at $0 balance throughout).
- E2E proof of the watcher: SO-0027 / receipt #45 (TUDOR Black Bay 58, $2,260) sent to register →
  register full tender + completion simulated via API (state closed, $2,260 paid) → app left on
  the DASHBOARD, order never opened → within one watcher cycle the payment was imported and the
  sale was PUT back to pending·layby. LS truth after: state pending, $2,260 paid, note clean.
- Live capture during the same window: Al's own register test on SO-0021 / receipt #39 — four real
  register tenders ($3,000 cash, $1,500 CC, $2,000 CC, $4,800 CC = full $11,300) all imported;
  sale sits fully paid at **pending·layby** ("Layaway" in Sales history), $11,300 held as unearned.
- Residual (honest statement of the limitation): via the REGISTER path the completed state exists
  for up to ~30 seconds before the watcher reverts it (register receipt/journal events are native
  and immutable); the app path has no such window. Reconciliation identity after everything:
  cash 93,197.35 = recognised 44,299.35 + liability 48,898.00, delta 0, 0 violations. Orphan test
  orders SO-0025/26 (reload race duplicates) voided in LS and removed.

## 2026-08-21 (night) — Rolex service document set (RAFCAM011924), inline new-contact, locations
- **Rolex service documents** built from Al's "Rolex Receipt Estimate Invoice.xlsx" (DATA tab + 4
  print tabs). Scope per Al: printouts only, auto-applied when Brand = Rolex (service orders only —
  special orders keep standard documents). Print on a Rolex service order now opens a stage chooser
  (Receipt → Estimate → Confirmation → Invoice, suggested by order status, with "Standard document
  instead" as the fallback); each renders a print-faithful document — verbatim letters,
  acknowledgement/decision signature blocks, HST/GST from the order's location, and the full
  two-column LEGAL NOTICES appendix page (Document ID RAFCAM011924) — in an on-screen preview with
  Print/PDF. Bracelet/Dial print blank (handwriting) until fields are added; letterhead is the
  Cambridge Rolex corner per the workbook. Verified E2E on ORD-0030 (Rolex Submariner Date Ref.
  126610LN): chooser, Receipt, Estimate (necessary work 1,070.00 + HST 139.10 = 1,209.10, decision
  page), legal page all correct.
- **Inline new contact**: quote/invoice editors' contact dropdown gained "+ Add new contact…" —
  modal creates the contact and selects it on the document (verified on QUO-0009).
- **Locations** updated per Al: Cambridge, Waterloo, **Montréal - Rolex Boutique**, **Montréal -
  TUDOR Boutique** (renamed from "Montréal – TUDOR Royalmount"; its LS outlet/register + GST+QST
  mapping carried over; 2 existing docs migrated). The new Rolex Boutique temporarily shares the
  Montréal outlet/register mapping — remap in Settings → Lightspeed when its own outlet exists.
- Deploy note: a hand-pasted DB chunk diverged from the file by two invisible NBSP characters —
  caught by the concat-sha check, located via segment hashes, normalised on both sides. The
  byte-exact sha pipeline continues to prove its worth.

## 2026-08-22 — Premium dashboard, Quotes → Estimates, de-branding pass 2
- Dashboard redesigned for the luxury context: hairline stat ledger (gold top rule, letterspaced
  micro-labels, serif navy numerals) for Open/Accepted Estimates + Open/Overdue Invoices; a navy
  "position band" for the accounting heart — Deposits Held (unearned, champagne gold), Open Service
  Balances, Recognised Revenue — with the Lightspeed connection as a quiet status chip; slim
  outlined pill actions (New Contact · New Estimate · New Invoice). "Rolex Template -TEST" quick
  action and the template record removed.
- Quotes renamed **Estimates** everywhere user-facing (nav, pages, buttons, editor labels, doc
  header now ESTIMATE, terms text); new documents number **EST-xxxx** (existing QUO- documents
  keep their numbers). App title now "Raffi Jewellers — Estimates & Invoicing".
- Prior-vendor IP distance: no visible vendor name anywhere; Lightspeed customer codes for new
  contacts now **RJ-<id>** (legacy-prefixed codes still matched so existing links keep working); app is
  an original from-scratch build using generic estimate/invoice/service terminology.

## 2026-08-22 — Premium print documents + intake camera
- **Print was printing the app screen.** Service/special orders now render a flat document:
  centered Raffi wordmark, store + "Prepared for" blocks, reference table, every intake field as
  a label over a written value (no inputs), Work & Parts table, totals (incl. deposits received /
  balance due and the unearned-revenue note), deposits ledger, notes, Date/Signature rule.
  Estimate & invoice documents print flat too — @page margins, no card, shadow, gold bar or canvas.
- **Intake camera (Al's request).** "Photograph item (3s)" on the intake panel opens the rear
  camera full-screen, counts 3 · 2 · 1 and **captures automatically** — no shutter press. Shot is
  resized to 1280px, stored on the order like an uploaded photo (max 6), flash + toast confirm,
  thumbnail strip along the bottom, "Take another (3s)" restarts the countdown, Done/Esc closes and
  stops the camera tracks. Falls back to the upload control with a clear reason if permission is
  denied or no camera exists. Module sha 6ddb89f7 (Supabase chunks byte-exact).
- Deploy note: the Chrome extension went unresponsive mid-upload, so the GitHub Pages copy of
  raffi_module.js still lagged this build at the time of writing — Supabase was already current.

---

## 2026-08-23 — Service parent tab + working pipeline board

**What shipped**

- **Service is now a parent tab** in the sidebar. Estimates, Orders and Invoices sit under it as sub-tabs, using the same Font Awesome icons that were already there (Al: *"keep the side icons the same as what we have now, this looks good"*). A hairline gold rule marks the group; the parent stays lit while you are inside any of its three children, and the breadcrumb reads **Service › Estimates** rather than just *Estimates*.
- **The Service tab opens on an overview board** — a premium kanban across four phases, each with its own sub-stages:
  - **Estimates** — Draft / Sent · awaiting / Accepted → convert
  - **Service orders** — Intake · open / In the workshop / Ready for pickup
  - **Special orders** — Ordered / With supplier / Arrived · awaiting pickup
  - **Invoices** — Open / Part paid / Overdue
  - a "Show closed & settled" toggle adds the archive column to each phase (Declined / Closed / Picked up / Settled).
- Above the board: the four premium stat cells (awaiting client, in the workshop, ready for pickup, **deposits held · unearned**), plus a board search and a location filter (Cambridge, Waterloo, Montréal - Rolex Boutique, Montréal - TUDOR Boutique).

**The board actually moves the work.** Dragging a card is a real transition, not a cosmetic one:

| Drag | What happens |
|---|---|
| Estimate Draft → Sent | runs the real *Send estimate* action |
| Estimate → Accepted | confirms, then stamps the acceptance into the activity log |
| Estimate → Draft | refused — *"An estimate cannot go back to draft once it has left the store."* |
| Order between workshop stages | permission-checked (`edit_service`) and validated against `ALLOWED_NEXT`; logged and audited |
| Special order → Arrived, no Raffi ID yet | opens the **Receive** dialog so the line switches to the real Salesforce Raffi ID and the real product |
| Order → Completed | refused — *"Use Complete & close on the order — that is what recognises the revenue."* |
| Invoice cards | not draggable at all; *"Invoice stages follow the payments — take the money on the order so deposits stay unearned."* |

The two refusals are deliberate: **no drag can ever recognise revenue.** Money is still only earned at *Complete & close* or a register final payment, exactly as before.

**Height — "lots of orders in various stages"**

The board now measures the space actually left in the window and takes all of it (`kbFit()`, re-run on every render and on window resize), so every stage header stays on screen and the **cards scroll inside their own column** instead of pushing the page down. The footer and the page's bottom padding are suppressed while the board is showing (`body:has(.kb)`), which buys back ~105px of card area. Below 900px wide the board falls back to the stacked mobile layout.

Verified on the live build: board bottom 796px against an 810px viewport, **page does not scroll**, 34 cards across 12 columns, 26 draggable, column counts shown in each header.

**Bugs found and fixed along the way**

- `NAVPARENT` had no `service` entry — the Service view left the breadcrumb reading "Dashboard" and highlighted the wrong sidebar item. Also added the long-missing `specialorders` entry, which had the same symptom on that page.
- A `String.replace()` patch silently ate a `$$` (jQuery-style selector helper) because `$$` is a replacement escape sequence. Caught by re-reading the patched region; repaired and confirmed against the backup that the file has exactly one `$$(` as before.

**Deploy**

- `raffi_module.js` sha256 `fa72bf4b18a09f094672d9c7e6b24a524b73f2ea37f4ab23d6e2cc80fad2f8ad` (174,420 chars) — GitHub raw, GitHub Pages and the Supabase chunk table all byte-identical.
- `index.html` 109,697 bytes, inline JS syntax-checked before upload.

**Reconciliation after the change:** cash 115,787.35 = recognised 44,289.35 + unearned liability 71,498.00 — delta 0, 0 violations, 17 open orders. Test store `developerdemoxeqwzt` only.

**Still open for Al's call**

- Special Orders remains its own top-level sidebar item *and* appears as a phase on the board. Easy to fold it under Service if he prefers one home for it.
- The workshop sub-stages are the existing open / in progress / ready. Finer stages (e.g. *awaiting parts*, *quality check*) would need a new status field.
- Four phases side by side are ~3,100px wide, so a 1,540px window shows two at a time and scrolls horizontally. A "jump to phase" chip row would make that a click instead of a scroll if he wants it.

---

## 2026-08-23 (later) — EST- numbering, one navy ledger, collapsible feed

**Estimates are numbered EST-**

`makeQuote` already minted `EST-` after the Quotes → Estimates rename, so new records were fine — but everything created before it still read `QUO-`. A migration (`estRenumber`) now walks the whole document on load and rewrites every historical `QUO-` reference: the numbers themselves, the activity feed, the audit trail, item descriptions, revision suffixes (`QUO-0003-2` → `EST-0003-2`). It skips data URIs and long blobs so photos and signatures are never touched, and it is idempotent. The built-in seed data was updated to match. Verified live: every estimate reads `EST-`, no `QUO-` survives anywhere in the document, and the counter carries on at EST-0015.

**One navy ledger instead of white stat cards**

Al: *"get rid of the individual big rectangle buttons, this looks too close to [prior vendor]."* The four white plates are gone. Everything now lives in a single navy panel:

- **Hero** — Deposits held, in gold, with the count of open orders and the caption *"Client money sitting on open work — not revenue until the piece is collected."* plus the age of the oldest open order.
- **Top tier** — Still to collect · Recognised revenue · In the workshop · Ready for pickup, each with a live sub-line.
- **Second tier** — the estimate and invoice book: Open estimates (oldest waiting N days), Accepted (N ready to convert), Open invoices (N due within 7 days), Overdue (or *"every invoice is current"*).
- **Footer** — the reconciliation identity, live: *cash received = recognised + held unearned*, with a Books balance / Out by … verdict.

Every cell is clickable, lifts on hover and reveals an Open → cue; the figures count up on paint. The Service overview band was converted to the same treatment so the two screens match.

**The footer caught a bug in its own first render.** It reported *Out by CA$-10.00*. The data was fine — the formula was mine: `cash` excluded cancelled orders while `recognised` still counted ORD-0004's CA$10 cancellation fee. Cash received now counts every dollar taken in, cancellations included, and the identity closes at zero.

**Activity feed folds by date**

Each date is a `<details>` section with an event count. It behaves as an accordion — opening a date folds the others, so the page stays short however much history builds up. The newest date is open by default; Expand all / Collapse all overrides it deliberately; open/closed state survives a re-render. Built on native `<details>`, so keyboard and screen-reader behaviour comes for free (the persist listener runs in the capture phase because `toggle` does not bubble).

**Smaller things**

- Lightspeed status moved out of the metrics panel and into the top bar, left of the user: a green pulsing dot with *Synced · developerdemoxeqwzt*, or red *Lightspeed · not connected*. Verified live in both states.
- The dashboard **Configure** button is gone; Settings stays in the sidebar. `NAVPARENT` also gained its missing `specialorders` entry.
- The round gold **+** in the sidebar is now a wide gold button labelled **Quick Action** (it reverts to the circle when the rail collapses under 900px).
- Quick actions rebuilt as three cards — icon medallion, title, and a line of purpose — leading with New Estimate. They invert to navy on hover.
- The dashboard lede is now time-aware and says something useful: *"Good morning, Al — 2 pieces are ready for collection."* The italic half is picked live, in priority order: overdue invoices → ready for pickup → on the bench → estimates with clients → *"the book is clear."*

**Verification.** Chromium ran the built files headlessly: zero page errors, hover states measured (plate lifts 3px, action card inverts, cues reveal), the accordion proven to leave exactly one date open, and the feed's Expand/Collapse all counted 1 → 3 → 0. Then confirmed against Al's live data: books balance at cash CA$115,797.35 = recognised CA$44,299.35 + held CA$71,498.00.

**Deploy.** `raffi_module.js` sha256 `6208d31dbaba7fb7697dfd4eb66fc839a0e3b1b7c61884f68d5e4ed5bf5736fa` — GitHub, Pages and the Supabase chunk table byte-identical. Test store `developerdemoxeqwzt` only.

**Note on tooling.** `raw.githubusercontent.com` caches for 5 minutes and ignores cache-busting query strings, which twice made a landed commit look like a failed one. Verify a deploy through the Pages URL from the browser, not raw from the container.

**Quick actions restruck.** The three pale rectangles read as secondary against the cream ground. They are now full plates — 96px tall, deep navy with a gold hairline frame and a gold icon medallion — and **New Estimate is struck in solid gold** with a navy medallion, so the primary action is unmistakable. A soft light sweeps diagonally across a plate on hover, the medallion swells slightly, and the arrow slides in. The navy matches the ledger above, so the dashboard now reads as two deliberate bands rather than a panel followed by loose cards.

**Dashboard lede.** Al asked for one row and no live status — an intro, nothing more. It is now `Good afternoon, Al` on a single line (the first name in gold italic), with a short engraved gold rule beneath it in place of the old left bar. The live status line was removed; that information already lives in the ledger directly below.

---

## 2026-08-23 (later still) — Orders are now Jobs

**The label.** *Orders* is *Jobs* everywhere it is visible: the sidebar sub-tab, the breadcrumb (**Service › Jobs**), the page title, the job detail panel, the contact record's list, the board phase, the convert button on an estimate (*Convert to job*), the empty state, and every toast that mentioned an order. The internal names — `db.orders`, `orderPaid`, `data-view="orders"` — were deliberately left alone: renaming those buys nothing and risks a great deal.

**The prefix.** New jobs mint `JOB-`, and the renumbering migration was extended to rewrite every historical `ORD-` reference the same way it handled `QUO-` → `EST-`: numbers, activity feed, audit trail, descriptions. Verified live — no `ORD-` survives anywhere in the document, jobs read JOB-0003 onward, and the counter continues at JOB-0031.

**Special orders were left alone on purpose.** They keep the `SO-` prefix and their own top-level tab. The word "order" is correct for them — a Rolex on order from Geneva is not a job on a bench — and blurring the two would have cost the distinction that the whole special-order lifecycle depends on.

**Special orders off the Service board.** Al: *"you can remove special order kanban from services."* The board is now three phases — Estimates, Jobs, Invoices — nine live columns. Special orders are reached from their own tab. Verified: no SO- card appears on the board.

**Books re-checked after the rename:** cash CA$115,797.35 = recognised CA$44,299.35 + held unearned CA$71,498.00, delta 0.

**Deploy.** `raffi_module.js` sha256 `47f32f6725733832e80268f8254de03082b821646feba4815d367cf6d45a8878` — GitHub, Pages and the Supabase chunk table byte-identical.

**One caveat worth knowing.** Lightspeed sale notes posted before today still carry the old `ORD-` text; those are historical records at the register and are not rewritten. Open layaways pick up the new number the next time the app posts to them, so the two converge as work moves.

---

## 2026-08-23 — Why the dashboard loaded slowly, and the fix

Al reported the ledger panel arriving late. Measured rather than guessed, using the browser's own navigation and resource timings against the live site.

**The page itself was never slow.** First contentful paint was 308ms and the module was fetched and parsed by 397ms. Four Supabase round trips were the whole problem:

| call | start | duration |
|---|---|---|
| `raffi-state` (read) | 399ms | **1,755ms** |
| `status` (Lightspeed) | 2,156ms | 903ms |
| `raffi-state` (write) | 2,490ms | 1,021ms |
| `raffi-state` (write) | 3,517ms | 393ms |

Nothing rendered until the read *and* the Lightspeed handshake had both returned — about 2.7 seconds of blank. The state document is only 147KB, so this was edge-function latency, not payload.

**Three changes:**

1. **Paint from the local copy first.** `loadDB` used to try the server, then fall back to the browser's copy. It now reads the browser's copy immediately and fetches the server copy in parallel, adopting it and re-rendering when it lands. If the user has changed anything in that window (`dirtySinceBoot`), their work stands and the existing 409 conflict path resolves it — the server copy never silently overwrites an edit.
2. **The Lightspeed handshake no longer blocks the first paint.** `lsBoot` renders, *then* calls `LS.status()`, then renders again. The sync chip starts neutral and turns green a moment later, which is honest about what the app actually knows.
3. **No write on boot.** `migrateDB` mutating the document triggered a save on every single page load. It now compares before and after and only commits when the migration genuinely rewrote something — which removed both write round trips.

Plus a `<link rel="preload">` for the module (the injected script tag is invisible to the preload scanner, so the fetch could not start until 79KB of inline script had parsed), a shimmer skeleton in place of the panel so nothing pops in on a cold first visit, and the count-up was removed — figures animating up from zero were themselves reading as "still loading".

**Measured after:** first contentful paint **128ms** (from 308ms), the ledger painted with real figures at first render (from ~2,700ms), two Supabase calls instead of four, and both boot writes gone.

**Premium pass on the panel** at the same time: an engine-turned ground — two fine diagonal rulings over the navy, the way a dial is finished — a brighter gold rule across the top, fine gold corner ticks at the base like the marks on a certificate plate, a hairline gold divider with a small lozenge between the two tiers, a darker recessed footer for the reconciliation line, more air throughout, and a larger hero figure. Cells fade up in a 50ms stagger, disabled under `prefers-reduced-motion`.

**Deploy.** `raffi_module.js` sha256 `3372532802ed6e7b1031c174ba98b8605e43da58b92fcee9bc4aeebefbc229b9` — GitHub, Pages and the Supabase chunk table byte-identical. (The chunk table drifted by 188 characters on the first pass: three comment lines I had dropped from the SQL. Caught by the concat-sha check, located by probing for the comment text, repaired.)

**Amounts made prominent.** The figures were being out-shouted by their own labels. Supporting cells went from 23px to 32px and the second tier from 25px to 33px, both in near-white rather than the muted ivory, with a faint glow for depth; the hero went from 46px to 56px in a brighter gold. The `CA$` mark is now gold-tinted in every cell, tying the supporting figures to the hero, and the decimals were lifted from 0.62em/50% to 0.66em/62% so cents read as part of the number instead of an afterthought.

Stress-tested at six-figure magnitudes (`CA$271,498.00`) rather than the current data: at a 1280px window the hero overflowed its cell. All three sizes are now `clamp()`-based — 56/32/33px on a wide screen, scaling down with the panel — and re-tested clean at 1600, 1440, 1280 and 1180px.

`raffi_module.js` sha256 `bd037d01cecc30f3f516f6a5b560cc127e9dfbced1cb58b75ac8941d4ebb4d6f`; GitHub, Pages and the chunk table byte-identical on the first pass.

---

## 2026-08-23 — Two defects the local-first boot introduced

Al asked to "connect to lightspeed and server". Both *were* connected — the app was lying about it, and one of the lies was hiding a data-loss risk. Both were my own bugs from the local-first boot rework earlier today.

**1. The offline banner never cleared.** The first paint happens before the server has answered, so `serverOK` is still false and `bannerHTML()` correctly draws *"Shared server storage is unreachable."* The reconcile then returned early when the server document matched what was already on screen — skipping the re-render that would have cleared it. The banner stayed up for the whole session while the server was perfectly healthy. The reconcile now repaints unconditionally once the handshake lands, whether or not the document changed.

**2. Saves made in the first second were silently dropped.** `pushServer()` opens with `if(!serverOK) return;` — sensible when that flag meant "the server is down", but under local-first it is also false for the ~600ms before the handshake completes. Anything committed in that window was written to localStorage and then quietly discarded on the server side, with no retry and no warning. It now parks the write (`pendingPush`) and `loadDB` flushes it the moment the server answers.

**3. The sync chip read "not connected" while Lightspeed was live.** A race: `LS.status()` refreshes `db.settings.ls`, and the server document lands a moment later carrying an older copy of that same branch — overwriting the fresh handshake result. The reconcile now preserves the live Lightspeed status (`lsStatusFresh`) across the swap, and `LS.status()` gets one retry, since a cold edge function can fail the first call.

**Verified end to end on the live test store:**

- Server read — 200, document version 357, 26 orders present.
- Server write — `commit()` moved the version 357 → 358 and the server confirmed 358, with nothing parked and nothing in flight afterwards.
- Lightspeed reads through the proxy — outlets (Cambridge, Waterloo, Montréal – TUDOR Royalmount), retailer **Raffi Test Store** on `developerdemoxeqwzt`, and the three registers.
- Sync chip green, offline banner gone.
- Books unchanged: cash CA$115,797.35 = recognised CA$44,299.35 + held unearned CA$71,498.00, delta 0. 11 jobs, 15 special orders.

**Lesson.** Making the first paint independent of the network was the right call, but every flag that previously meant "the network is broken" now also means "the network has not answered yet". Those two states need to be told apart — one warns the user, the other waits.

`raffi_module.js` sha256 `76701d11b79ff6ccca0861e68d31143509927445d85b74d69b6ff02129f14636`; GitHub, Pages and the chunk table byte-identical.

---

## 2026-08-23 — Five stores, and a Montréal mix-up

Al: *"rolex boutique montreal and tudor boutique montreal and waterloo and cambridge are 4 different stores"*, then *"i would add in cambridge rolex as a 5th store"*.

**The bug this surfaced.** Montréal - Rolex Boutique and Montréal - TUDOR Boutique were mapped to the **same Lightspeed outlet and the same register** (`Montréal – TUDOR Royalmount` / `Montréal Register`). Two separate boutiques were set to post into one till — their sales, inventory and takings would have been indistinguishable in Lightspeed. Nothing had actually been posted from the Rolex boutique yet (0 records at that location), so no history needs unpicking; the fault was in the configuration waiting to happen.

**What changed in the data** (saved, server version 359):

| Store | Outlet | Register | Tax |
|---|---|---|---|
| Cambridge | Cambridge | Main Register | HST 13% |
| **Cambridge Rolex** *(new)* | — unmapped — | — unmapped — | HST 13% |
| Waterloo | Waterloo | Waterloo Register | HST 13% |
| **Montréal - Rolex Boutique** | — unmapped, was TUDOR's — | — unmapped — | GST+QST 14.975% |
| Montréal - TUDOR Boutique | Montréal – TUDOR Royalmount | Montréal Register | GST+QST 14.975% |

Unmapped is deliberate and safe: `buildSale` already refuses to post from a location with no outlet or register (*"Location X is not mapped to a Lightspeed outlet/register"*). Better a clear refusal than a sale quietly landing in another boutique's books. Verified: no two stores now share an outlet, and the two unmapped stores block posting.

**What changed in the code.** `syncRef()` auto-maps locations to outlets by name, but exact-matched, so `Montréal – TUDOR Royalmount` (en dash) would never match `Montréal - TUDOR Boutique` (hyphen). Matching is now tolerant of the differences that actually occur between what someone types in Lightspeed and what the app calls a store — en/em dashes versus hyphens, accents, and stray double spaces — while still refusing false positives (`Cambridge` does not match `Cambridge Rolex`). A mapping pointing at an outlet or register that no longer exists is also cleared now, so it can re-attach by name instead of silently pointing nowhere.

**A tooling trap worth recording.** The chunk table's SQL path rewrites lone backslashes: a regex literal written `/\s*-\s*/` came back as `/\\s*-\\s*/`, which matches a literal backslash rather than whitespace — a silent functional break, not just a byte-drift. Two attempts to repair it with `replace()` and `regexp_replace()` failed the same way because the correction was mangled in transit too. Fixed by (a) rewriting the function so every backslash lives inside `new RegExp('\\...')`, where doubling survives the round trip, and (b) shipping the corrected block through `convert_from(decode(...,'base64'))`, which nothing can rewrite. **Use base64 for any chunk-table edit containing backslashes.**

`raffi_module.js` sha256 `a1a342eac004537dd4ce911242354a339063f839729564550e0f5d38cdb7334f`; GitHub, Pages and the chunk table byte-identical.

**Waiting on Al** — he is creating the outlets in Lightspeed, then the app maps them.

**Outlets created, all five stores mapped.** Al created the two missing outlets and their registers (naming them `Montréal Rolex 1` and `Cambridge Rolex 1`). A `syncRef()` attached them by name automatically — no manual mapping needed, which is what the tolerant matcher was for:

| Store | Lightspeed outlet | Register | Tax |
|---|---|---|---|
| Cambridge | Cambridge | Main Register | HST (ON) 13% |
| Cambridge Rolex | Cambridge Rolex | Cambridge Rolex 1 | HST (ON) 13% |
| Waterloo | Waterloo | Waterloo Register | HST (ON) 13% |
| Montréal - Rolex Boutique | Montréal - Rolex Boutique | Montréal Rolex 1 | GST+QST (QC) 14.975% |
| Montréal - TUDOR Boutique | Montréal – TUDOR Royalmount | Montréal Register | GST+QST (QC) 14.975% |

No two stores share an outlet, every store has a real Lightspeed tax id attached at the correct rate, and all five now pass the posting guard. Books unchanged: cash CA$115,797.35 = recognised CA$44,299.35 + held CA$71,498.00, delta 0.

**A multi-tab clobber, caught mid-task.** After the five stores were saved (version 359), the list silently reverted to four. One of three app tabs Al had open was holding an in-memory document from before the change; when it next committed it wrote its stale copy over the top as version 360. The 409 conflict path did not catch it because that tab's `base_version` was current by then — it had refreshed its version pointer without refreshing its document.

Recovered by reloading the stale tabs, re-reading the server copy, re-applying the change on top of it, and re-verifying (version 363, five locations, five mappings).

Worth fixing properly: the conflict check compares versions, not content, so a tab that has been sitting open all day can overwrite newer work without ever seeing a conflict. A cheap improvement would be for `pushServer` to re-read and merge when its document is older than the last one it adopted, or for a tab to refuse to push after being hidden for a long period without a re-read. **Recommend running one tab at a time until that is fixed.**

---

## 2026-08-23 — Multi-store routing proven, and the Day Book

**The rename landed and all five stores map cleanly.** After Al renamed the Montréal outlet, a `syncRef()` left every store matching its outlet by exact name, each on its own register, no outlet shared by two stores.

**Proven where it counts.** Configuration being right is not the same as money landing in the right till, so JOB-0031 was raised at the newly created **Cambridge Rolex** store with a CA$400 deposit recorded outside the register. In Lightspeed the sale came back:

- posted to outlet **Cambridge Rolex**, register **Cambridge Rolex 1** — not Cambridge, not TUDOR
- state `pending`, attributes `["layby"]` — an open layaway, so the deposit stays unearned
- CA$400 against CA$1,356, note `JOB-0031 — Rolex full service`
- receipt **#2**, its own fresh sequence in the new outlet

That is the whole multi-store change working end to end.

**Activity Feed → Day Book.** Al: *"change this title, also make this section much more premium ui ux and easier to read, cleaner, also be unique in terms of functions applied."*

Renamed to **Day Book** — the bookkeeping term for the daily record of transactions, which is precisely what it is, and nothing like a generic activity feed.

Rebuilt as one line per entry instead of the stack of heavy white cards: a gold timeline spine with small lozenge nodes, the actor as initials, a gold action icon, the entry text, and a relative timestamp (*"2 hours ago"*, exact time on hover) right-aligned. Far less ink for the same information.

Three functions it did not have:

1. **Folded days still tell you something.** Each collapsed date carries a summary — *"CA$400 taken · 2 estimates · 4 jobs"* — so the book stays short without going blind.
2. **Filter chips by kind** with live counts, derived from the record each entry points at rather than its icon: Money 51 · Estimates 27 · Jobs 15 · Special orders 21 · Invoices 8 · Clients 1.
3. **Search across the book**, matching entry text and the person, keeping focus and caret position through the re-render.

**A flaw caught before it shipped.** The first version scraped the day's money out of the entry text with a regex, which reported *"CA$261,963.50 moved"* on 21 August — roughly double the true figure, because it was picking up order totals alongside payments. A summary that overstates takings is worse than one that omits them. It now sums the actual payment records for that day, refunds netted. Cross-checked every day against the payment ledger: 400 / 137,943.50 / 453.85 / 0 / 0 / 0 — all exact.

**Single currency.** `CA$` is gone: the setting, the fallbacks in both files, and the 53 historical log entries that had it written into their stored text. The Movements list and every figure now read plain `$`.

**Pickers.** The location filter was a default browser select — a white rounded rectangle with a grey chevron. All three pickers are now engraved pills: an ivory-to-white gradient with an inner top highlight, a warm hairline border that turns gold on hover, a gold chevron, and uppercase letterspaced navy labels matching the app's label language. The store picker additionally carries a small gold lozenge mark on the left, so the one that changes what you are looking at is distinguishable at a glance from the ones that merely filter. Checked at the widest store name (`Montréal - TUDOR Boutique`) — no clipping, and the pill collapses to full width under 640px.

---

## 2026-08-24 — Four ways a till could lose a record, and the end of them

Al: *"fix it keep going do anything else needed."* This is the fix for the multi-tab clobber flagged on 22 August, plus three more holes the live test opened up on the way. Each one is written down with the evidence, because each one silently destroyed a record before it was closed.

### 1. A tab left open could overwrite newer work without ever seeing a conflict

The 409 check compared `base_version` against the server, but the app was sending the newest version it had *seen*, not the version its document had come *from*. A tab that refreshed its version pointer without adopting the document that came with it held a write token for work it had never seen, and the server accepted it.

Saves are now keyed to `docVersion` — the version the in-memory document actually came from. When the server rejects one, the app no longer just takes the server copy and drops yours: `carryOverMissing()` takes their copy as the base and carries across anything of yours they have never seen, by record id, across contacts, estimates, jobs, invoices, payments and products, with counters advanced to the higher of the two. Records both sides hold keep the server's version — one till must not silently rewrite another's edit — but a job raised at your counter cannot vanish because a second till saved a moment earlier.

**Proven live.** Two tills open on the same document at version 388. Till A saved a new client; till B, still holding 388, saved a different one. Till B's save was rejected, merged, and re-sent: server version 391 holds **both** records, and till B's screen came back carrying the client it had never seen, with a line in the audit trail reading *"server version 390 adopted; 1 local record(s) carried over"*.

### 2. A merged tab kept the losing copy in its own browser

The browser mirror was written before the save went out, so after a merge the tab held the merged document in memory but its **pre-merge** copy in localStorage. Close that tab, reopen it out of signal, and the losing side of the conflict comes back to life.

`mirrorLocal()` now writes the merged document straight away. It is called after the audit line is added, not before — otherwise a conflict that carried nothing across is never re-sent, and the browser copy is the only place it could have been recorded, so the event would leave no trace at all.

### 3. The gap between the server answering and its answer being used

This one cost a record during testing, in front of me. The app paints from the browser's own copy first so the screen is not blank while the server answers. If anything saved in the window *after* the server answered but *before* its document was adopted, the save went up carrying the browser copy with a version number that happened to match — the server saw no conflict, and the newer records went quietly. The migration that stamps the build number on boot is enough to trigger it.

Nothing is written up now until the server has answered this boot, win or lose. Saves made before then are parked, not dropped, and released once the position is known.

### 4. The stored version number could vouch for a document the server never accepted

The version number and the document are two separate keys in the browser, written at different moments. A tab that merged a conflict and was closed a second later left the newer number sitting beside the older document. On the next boot the two were paired, and that pairing handed the server a write token for a document it had never seen.

The number is still written, for diagnosis. It is no longer read back as authority. A boot now starts with no write token at all, so the first save either follows the adopted server copy — a real token — or goes through the conflict merge. Both are safe; the old behaviour was neither.

**Proven live.** A document one record behind the server was planted in the browser beside a version number saying the server had accepted it, with a stale build number to force a save on boot. Under the old build this exact shape returned `200` and destroyed the record. It now returns **409**, the server copy is adopted, and the server stays untouched at version 388 with the record intact.

### Housekeeping in the same pass

- Browser storage key moved off the legacy vendor-named key to `raffi-service-db-v1`, and the signed-in-user key from `the legacy signed-in-user key` to `raffi-current-user`. Both read the old key once so nobody is signed out or loses local data, then retire it. Exported files are now named `raffi-service-data-*.json`.
- The remaining occurrences of the old product name in the code are the legacy key read and the routine that finds and removes its branded generic service product from the Lightspeed catalogue. Neither is visible to anyone using the app.

### Recommendation withdrawn

The 22 August note said to run one tab at a time. That no longer applies — more than one till on the same document is now safe, and a rejected save tells the person what happened rather than failing quietly.

**Books unchanged throughout:** cash $116,197.35 = recognised $44,299.35 + held $71,898.00, delta 0.

### Note on the test records

The live tests created contacts named `ZZ Test - …`. Three were being removed through the app when the browser extension dropped; any still listed under Contacts are empty (no estimates, jobs or invoices, no Lightspeed customer) and can be deleted from the contact page. One, `ZZ Test - Counter A`, was destroyed by defect 3 during the test that exposed it — the only record lost, and the reason defect 3 is now closed.

---

## 2026-08-24 (later) — Both flows walked end to end, with the pictures to prove it

The help doc now carries 23 screenshots, every one taken while doing the thing it describes, in the test store, this morning. The Lightspeed images are that store's own sales-history screen — not the app's account of what Lightspeed holds, which is the point.

### The service: EST-0015 → JOB-0032 → INV-0010

Rolex Submariner 116610LN for a client at Cambridge Rolex, $1,050 + HST. Written as an estimate, signed on screen by the client, converted to a job. Until the first deposit the job's Lightspeed field reads, in as many words, *"not created yet (created when first deposit is taken)"* — nothing exists on the platform side.

Three payments over ten minutes: $400 card, $500 e-transfer, $286.50 debit. **One Lightspeed sale, receipt 3, throughout** — the second and third payments landed on the same layaway rather than opening new sales, so the client has one receipt number for the whole job. Balance fell 786.50 → 286.50 → 0.00; status stayed `Layaway` until the final payment was taken with *complete & close* ticked, at which point it read **Layaway, completed** and the whole $1,186.50 was recognised — including the deposit taken at 08:14.

### The special order paid in full before the watch existed: SO-0033 → INV-0011

Rolex GMT-Master II Ref. 126710BLRO for a client at Montréal - Rolex Boutique, $14,500 + GST/QST = $16,671.38, expected 15 November. The client wired **the entire amount** up front.

The three states worth photographing, all read off Lightspeed's own screen:

1. **Paid in full, nothing owing** — sale total $16,671.38, payment $16,671.38, **balance $0.00**, status **Layaway**. Not a sale. The line reads *Special Order Product* at GST+QST 14.975%, because the watch is not ours yet.
2. **Received into inventory** (Raffi ID RAF-48192) — the line switches to *Rolex GMT-Master II Ref. 126710BLRO*, same sale, same money, **still Layaway**. Receiving stock recognises nothing.
3. **Collected** — *Complete & close*, and only then does it read **Layaway, completed**. The money arrived at 08:19; it became revenue at 08:24.

That middle state is the whole argument in one picture: zero balance, full amount in the till, the real watch on the line, and the platform still refusing to call it a sale.

### Two guards, found by walking into them

Closing a special order refuses twice before it will go through: once until the **Raffi ID** is entered — the layaway line has to be the real product before it can be sold — and again until the **serial number** is filled in, because the final receipt has to name the actual watch. I hit the second one live with the serial box empty: *"Could not close in Lightspeed: Serial number required to fulfil a special order."* Both are now written into the doc's refusals section, with the screenshot.

### Books after both

Cash received **$134,055.23** = recognised **$62,157.23** + held unearned **$71,898.00**, delta 0. The held figure did not move, because both of these were taken and collected on the same day — which is itself the right answer.

**Published** to the same address: <https://claude.ai/code/artifact/44fd4369-bc4a-4074-8277-2813c0e8d5e3>

### Test data cleaned up

The four `ZZ Test - …` contacts from the concurrency tests were deleted through the app. The document is back to its pre-test counts on everything except the two real records this walkthrough created (JOB-0032 / INV-0010 and SO-0033 / INV-0011), which are genuine completed work and were left in place.

---

## 2026-08-24 (afternoon) — Lightspeed's revenue figure is right, and a number collision that wasn't

Al, seeing $15,550 on the Lightspeed home dashboard: *"lightspeed is still showing it as revenue in their dashboards."*

### It is revenue, and it should be

$15,550 is the ex-tax total of the two sales **closed** during the morning walkthrough — JOB-0032 at $1,050 and SO-0033 at $14,500 — and "average sale value $7,775" is that over exactly two sales. Both were handed to the client, so they are earned. The dashboard is not counting layaways.

Rather than argue it from arithmetic, it was tested: a new $4,000 special order was raised at **Cambridge**, a **$500 deposit** taken, and the sale deliberately left open.

| | before | after |
|---|---|---|
| Today's sales | $15,550.00 | **$15,550.00** |
| This month's sales | $87,455.90 | **$87,455.90** |
| Revenue, Cambridge outlet | $0.00 · 0 sales | **$0.00 · 0 sales** |
| Payment report, that day | — | **Cash $500.00 appears** |

Money received shows in the payment report; revenue does not move until the sale closes. That is the correct split and Lightspeed makes it correctly. The test order was then cancelled and refunded in full; revenue stayed at $15,550 throughout.

### The thing worth flagging: two tills, one number

While that test was running, Al was in the app raising an **OMEGA Seamaster special order for $11,300**. Both counters allocated a number from their own copy of the counter and **both records came out as SO-0034**.

Nothing was lost — this morning's merge carried both through, which is exactly what it is for — but a shared document number is bad paperwork, and the merge had no opinion about it.

**Fixed.** `carryOverMissing` now hands off to `renumberCollisions`:

- The record **already on the server keeps its number** — a client may be holding paperwork with it.
- The newcomer is **re-issued from the merged counter**, and remembers what it was.
- Estimates, jobs, special orders, invoices and payments are all covered, each from its own counter and with its own prefix.
- The change is **not** left to a toast. It is written to the audit trail, and it sits on the job as a notice — *"This was SO-0034 — it is now SO-0037"* — with the one thing that still needs doing spelled out: the Lightspeed sale note still carries the old number until someone presses **Sync with Lightspeed**. It stays there until acknowledged.

Eighteen assertions cover it offline (incumbent keeps its number, newcomer re-issued, correct prefix per kind, colliding payments handled, three-way collisions all resolve distinctly, non-colliding numbers untouched, counters never reused, null-safe).

**Live data repaired.** Al's OMEGA order keeps **SO-0034**; the cancelled test order was re-issued as **SO-0037**, with the reason written into the audit trail. No duplicate numbers remain in any collection.

### A near miss worth recording

The Supabase chunk update for this change came out **84 characters short** — one comment line was dropped while transcribing the block into SQL. The content still parsed and every new function was present, so nothing would have looked wrong; the concat-md5 check against the local file is the only reason it was caught. This time it was a comment. It is the same one-line slip that would silently drop a line of code, and it is why that check runs on every chunk write.

---

## 2026-08-24 (late) — One register payment, two records

Al, on a TUDOR special order: *"why is there a double payment recorded in the app"* — PAY-0056 and PAY-0057, both $22,600, both "final", both from the Lightspeed register, one minute apart.

### The client was charged once

Both local records carried the **same** Lightspeed payment id (`5afe8bf6-…-9fd1e863327a`), and Lightspeed's own figure for that sale was `paid: 22,600` — one payment. So the card was charged once and Lightspeed is right; the app had recorded that one payment twice.

It was not isolated. Three orders were affected:

| Order | Duplicate | Amount |
|---|---|---|
| SO-0041 | PAY-0057 | $22,600.00 |
| JOB-0039 | PAY-0059 | $1,943.06 |
| JOB-0040 | PAY-0055 | $400.00 |

### How one payment became two records

`importLsPayments` dedupes correctly within a single call. The duplication came from two browsers: each pulled the same Lightspeed payment, each created a local record for it, and those records had **different local ids**. The conflict merge — which had been taught to dedupe by record id — saw two distinct records and dutifully kept both.

The merge was right that neither record was "missing". It was wrong about what a payment *is*: a payment taken at the register is one row in Lightspeed, and its identity is Lightspeed's id, not ours.

### Four places it is now stopped

1. **The merge knows a natural key.** `NATURAL_KEY.payments` maps a payment to `ls:<lsPaymentId>`. A record whose external identity the other side already holds is not carried across, and the drop is written to the audit trail rather than passing in silence.
2. **One pull at a time per sale.** Two overlapping refreshes both read the payment list before either had written its import. Callers now share a single in-flight promise per sale id.
3. **The import guard looks at the whole book**, not just the order in hand — a Lightspeed payment id can only ever belong to one record anywhere.
4. **The server enforces it too.** `raffi-state` now strips duplicate `lsPaymentId` records on every write and reports how many it dropped.

Point 4 was not planned. After the first cleanup, the duplicates **came straight back**: the audit trail reads *"15:59:44 · conflict · server version 712 adopted; 3 local record(s) carried over"* — a still-open tab on the old build hit a conflict against the cleaned document and carried its three duplicates back in. Client-side fixes only bind clients that have reloaded. The server is the one place a stale browser cannot argue with, so the rule lives there as well.

**Proven:** a document containing a deliberate second copy of PAY-0056's Lightspeed payment was sent to the server. It replied `deduped_payments: 1`, stored 56 records instead of the 57 sent, and only PAY-0056 survives for that Lightspeed payment.

All three duplicates removed, each with its reason in the audit trail. No duplicate Lightspeed payment id remains anywhere in the book.

### Still open, and different: four sales where Lightspeed has double

`SO-0013`, `SO-0014`, `SO-0016` and `SO-0017` — all raised 21 August — show the mirror problem. The app holds one payment each; **Lightspeed holds two**, identical in amount and timestamp, with server-assigned ids:

| Order | App | Lightspeed |
|---|---|---|
| SO-0013 | 1,130.00 | 2,260.00 |
| SO-0014 | 2,000.00 | 4,000.00 |
| SO-0016 | 11,300.00 | 22,600.00 |
| SO-0017 | 7,000.00 | 14,000.00 (all three payments doubled) |

Every payment on those sales carries a Lightspeed id beginning `0285f360-5424-11f1-f6e2-`, while the app's stored ids are the client-supplied UUIDs it sent. The two never matched, so the app never learned Lightspeed's id — and a later re-post of the sale sent the payment again, which Lightspeed appended rather than recognised.

Today's sales do not behave this way: JOB-0032 (three payments, posted and re-posted four times) has exactly three payments in Lightspeed and every id matches; SO-0033 and SO-0041 match too. So the behaviour appears to belong to the 21 August build. **Not touched** — correcting payment rows inside Lightspeed sales is destructive and those four are historical test records. Flagged for Al to decide.

### The photographs

Both of Al's photos had saved correctly — the server held `intake-1.jpg` and `intake-2.jpg` (now four) the whole time. His screen was showing a copy taken before the second capture. Same root cause as everything else today: a tab holding a stale document.

---

## 2026-08-24 (evening) — Paying in full is not collecting

Al: *"paying a service job in full should also not count as earned revenue (stay as unearned) until the job is completed and picked up by customer."*

Two paths could recognise a service job's revenue. One was already right; the other was quietly wrong.

### Already correct: taking the money in the app

Taking a full payment through **Record payment (outside register)** posts the sale as `pending` and leaves the job open. The "complete service & close sale if this pays the balance in full" tick is unchecked by default and is the only thing on that screen that closes anything.

Verified live on **JOB-0042**: a $113 service job paid in full, and afterwards the header read *Open · LS: Layaway (open) #56* with **Remaining balance $0.00**. Lightspeed's own sales history showed receipt 56 as **Layaway**, not a sale. Money held, nothing earned.

### Wrong: the register was allowed to finish the job

The register force-completes a sale the moment the balance reaches zero — Lightspeed does not offer Layaway at a $0 balance. `importLsPayments` was reading that as the job being finished:

```
o.status='completed'; o.completedAt=Date.now(); o.completedBy=null; ensureInvoiceForOrder(o);
audit('order.completed', ..., {via:'register final payment (Lightspeed closed the layaway)'});
```

Note `completedBy: null` — nobody had said the client collected anything. A platform side-effect of a tender was recognising revenue and raising an invoice.

The reopen-as-layaway guard already existed, but its condition was narrow:

```
premature = closed && !completed && !cancelled && isSpecial(o) && !raffiId
```

So it only protected **special orders whose piece had not arrived**. Every service job, and every special order already received, fell through to the auto-complete.

**Now:**

```
premature = closed && !completed && !cancelled
```

A sale the register closed is premature for every kind of job, and is reopened as an open layaway. The auto-complete is gone entirely. A job paid in full at the register now says so and stays unearned:

> *JOB-00xx is paid in full. It stays unearned until you press Complete & close at pickup.*

Only two things in the whole app can now complete a job, and both are a person saying the client walked out with the piece: **Complete & close**, and the opt-in tick on a final payment. Asserted in the source, not just intended.

### Two jobs it had already caught

`JOB-0038` and `JOB-0039`, both completed today by the register with `completedBy` empty. Put to Al; he confirmed those pieces genuinely went out, so they stay recognised. From here the app will not make that call on its own.

### Not yet proven end to end

The record-payment half is verified live. The register half is verified by code inspection and source assertions only — the live tender could not be run because Lightspeed permits one Sell tab at a time and Al had it open. Worth running once he is free: tender a layaway in full at the register and confirm the job reopens rather than completing.

**Books after:** cash $178,796.99 = recognised $67,990.29 + held unearned $110,806.70, delta 0.

---

## 2026-08-24 (night) — The fix was right; the browser running it was not

Al, after tendering a service job in full at the register: *"it is still showing layaway completed sale in LS, with my test receipt #57."*

### What the audit trail said

```
17:30:23  order.completed
          {"via":"register final payment (Lightspeed closed the layaway)"}
```

That sentence does not exist in the deployed module — it was deleted with the auto-complete, and the served file was checked to confirm it. So JOB-0045 was completed by **a browser still running the pre-fix code**, not by the code that is live.

**Repaired.** JOB-0045 is back to **Open**, receipt 57 reads **Layaway** in Lightspeed again, the $254.25 is unearned, and the two invoices it raised (INV-0016 and INV-0017 — one of each from two contexts) are withdrawn. The reopen was done by the app's own mechanism: putting the status back to open made the sale premature by the new definition, and a sync reopened the layaway.

### The real problem: a stale tab cannot be reached

Three times today a browser holding old code undid a fix:

| Time | What it undid |
|---|---|
| 15:59 | carried three duplicate register payments back after they were removed |
| 17:30 | completed JOB-0045 from a register close |
| ~17:35 | carried both withdrawn invoices back |

"Please reload" is not a control. A browser already running superseded code will keep re-adding records the current code removes and re-making decisions the current code no longer makes, and nothing shipped afterwards can reach it.

### The gate

The document now remembers the highest `BUILD_SEQ` that has ever written to it. `raffi-state` refuses anything older with **426** and a plain message; the client shows a red banner — *"This tab is out of date and has stopped saving… nothing you have typed is lost"* — with a **Reload now** button. Reloading picks up current code and the ordinary conflict merge folds the parked work in.

It stays dormant until a client on the new build writes once, so a deploy never breaks anyone mid-transaction.

**Proven against the live endpoint:**

| Write | Result |
|---|---|
| build_seq 3 | `200` · version 888 · build_seq 3 |
| no build_seq (old tab) | **`426 stale_build`** · needs 3, sent 0 |
| document afterwards | version 888 — **unchanged** |

That is the third rule now enforced server-side rather than by asking clients nicely, alongside duplicate-payment dedup and optimistic concurrency. The pattern is worth keeping: anything that protects the books belongs where a browser cannot argue with it.

### Still owed

The register half of the unearned-revenue rule is now proven in the direction that matters — a register-closed sale *was* reopened as a layaway on JOB-0045. What has not been watched end to end is the automatic path: tender in full at the register and let the app notice by itself, rather than being nudged. Worth one run on a fresh job once every tab is on the current build.

---

## 2026-08-24 (late) — Two minutes to notice, one second to fix

Al, watching the reversal work for the first time: *"it says layaway completed, then it reverses, can we make it reverse faster."*

### Where the time actually went

JOB-0046 is the first clean end-to-end run on the current build, and the audit trail times it exactly:

| | |
|---|---|
| 18:08:22 | `payment.sent_to_register` — receipt 58, $276.85 |
| 18:10:17 | `payment.imported_from_register` + `paid_in_full_not_recognised` |
| 18:10:18 | `order.reopened_layby` |

**The reversal took one second.** The other 1m 55s was the app not yet knowing anything had happened. Nothing was wrong with the repair; the watching was slow.

### Why it was that slow

```
const o = watch.sort(...)[0];              // ONE order per pass
if(now - o.ls.lastAutoPull < 20000) return; // and not more than once per 20s
}, 25000);                                  // pass every 25s
```

One order per 25-second pass, round-robined. Three sales were sitting with an expectation open — JOB-0043 from 17:11 and JOB-0044 from 17:31, neither ever tendered — so the one Al was actually standing at the till for took its turn behind two stale ones. Three waiting sales meant roughly 75–115 seconds to be noticed, which matches the measurement almost exactly.

### Now

Every waiting sale keeps its own clock instead of competing for a single slot:

| How long it has been at the till | Checked every |
|---|---|
| under 4 minutes | **2 seconds** |
| 4–20 minutes | 8 seconds |
| beyond that | 30 seconds |
| beyond a trading day | dropped |

And it checks immediately whenever the tab is looked at again — `visibilitychange` and `focus` — which is usually the exact moment the rep comes back from tendering. That often beats the timer entirely.

Expected worst case for the sale someone is standing at: **2–3 seconds**, against 75–115 before. An expectation left over from the morning can no longer starve the one that matters now.

Eleven assertions cover the cadence offline, including the specific regression: three sales open, and the newest still keeps its own 2-second clock.

**`BUILD_SEQ` deliberately not bumped.** This is a responsiveness change, not a rule other tills must have before they may write — a tab on the previous build is slower, not dangerous. The gate is for correctness, and spending it on convenience would teach people to ignore it.

---

## 2026-08-24 (late) — The camera belongs to the client's piece, and so does the photograph

Al: *"you can remove camera function from special orders … this is just for service intakes so we can document for client"* and *"if there are photos on service intake categories (estimates, jobs, invoices) put the photos in the receipt print out so customer has a copy."*

Those are the same idea from both ends. The photographs record the state a client's own property arrived in. A special order is our merchandise coming from a supplier — there is nothing of theirs to photograph — and the record is only worth something if the client goes away holding a copy of it.

### Camera removed from special orders

The **Photograph item (3s)** button is no longer rendered on a special order, and `ACT.camOpen` refuses if it is reached another way, saying why:

> Intake photographs are for a client's own piece. A special order is our stock coming in — use Add photo if you need one on the record.

**Add photo** is left in place — occasionally there is a supplier picture or a shot of the piece as it arrived worth keeping — and anything already photographed stays on the record. Verified on SO-0041: camera button gone, Add photo present, the four existing photographs still shown.

### Photographs now print on the client's copy

A new block sits above the signature on the estimate and invoice, and above **Work & Parts** on the job document:

> **Condition photographs at intake — JOB-0045**
> *Photographed by Raffi Jewellers when the piece was received, and supplied with this document as our record of the condition it arrived in.*

All three documents resolve back to the same job, because that is where the piece lives: an invoice by its `orderId`, an estimate by the job raised from it, the job document directly. A special order prints no block; neither does a job with no photographs, so nothing gains an empty heading.

Print CSS keeps the strip on one page (`page-break-inside: avoid`), four across, each dated.

Eighteen assertions cover it offline — including that a special order with photographs on file still prints none, and that a photo record missing its image data is skipped rather than printing a broken frame. Confirmed live on JOB-0045's document: heading correct, both images embedded, note present, stylesheet loaded.

### A ten-character lesson, again

The chunk write came out 10 characters short. The cause: the local file carried `’` and `—` as escape sequences while the SQL carried the real `'` and `—`. Same output in a browser, different bytes on disk — and the concat-md5 check caught it, as it did the missing comment line earlier today. The local file was normalised to the real characters rather than the deployed copy being changed, since that is the version a person would rather read.

**Note for the print preview:** the Print button calls `window.print()`, which opens the browser's own dialog and blocks screenshots until dismissed. Verification was done by reading the rendered document instead.

---

## 2026-08-24 (late) — A document that starts with nothing on it

Al: *"remove this item line, keep the add line and add from products."*

A new estimate opened with one empty line already on it — no name, qty 1, price 0. **Add line** and **Add from products…** already sit under the table, so the blank row was not a shortcut; it was an invitation to leave a nameless zero-value line on a document going to a client.

Three places seeded or re-seeded it, and all three are gone:

1. `makeQuote` — a new estimate now starts with `items: []`.
2. `makeInvoice` — the same, for an invoice raised on its own. (One converted from an estimate still inherits that estimate's lines.)
3. `rmLine` — removing the last line used to push a fresh blank one straight back, which was the same behaviour by another route.

An empty table now says what to do instead of showing a row to fill in: *"Nothing on this document yet — add a line, or pick something from products."*

**Checked downstream before shipping.** Both `totals()` reduce from an initial 0, so an empty document totals zero rather than throwing, and every `items[0]` reader was already guarded (`it0 &&`, `if(!it) return`, `(x.items&&x.items[0]&&…)||''`). Special orders build their own line and are unaffected.

Verified live on EST-0029: opened with no row, **Add line** produced exactly one, removing it returned the empty state rather than another blank, and both buttons stayed put throughout.

---

## 2026-08-24 (late) — Templates removed, and a name audit

Al: *"remove this and anything that came over from [prior vendor], also do an audit and make sure we are not infringing on [prior vendor] IP."* The "this" was the **Templates** chip on the Estimates list.

Not a lawyer, and this was not a legal opinion. What follows is a factual sweep of a codebase and a database for one company's name, for strings and assets that could have been copied, and for anything the app writes into a third party's system carrying that name. Trade dress, look-and-feel and patent questions are outside what a file search can answer and need counsel.

### The feature

Templates were a saved-quote shortcut: a quote row with `isTemplate:true` and a `templateName` instead of a number. Fifteen touch points across `index.html` — the chip, the alternate table head and rows, the editor's template mode, `saveTemplate` / `useTemplate`, `delQuote`'s special-casing, five seeded records and the seeded `qt1` ("Rolex Template -TEST"). All removed. `realQuotes()` is kept as a name because `raffi_module.js` calls it, but it no longer filters anything.

The first patch attempt asserted on an anchor and wrote nothing — the script raised before touching the file, so `index.html` was unchanged and no half-edit landed. Rewritten to locate every edit by content rather than by line number and to apply them bottom-up, which is also why the second run needed no re-reading of shifted offsets. All three `<script>` blocks pass `node --check`.

### What actually carried the other company's name

**In the product.** The old vendor-named localStorage key, read once at boot to migrate a returning browser, in both `index.html` (`KEY_LEGACY`) and `raffi_module.js` (`LOCAL_KEY_LEGACY`). Gone from both. The migration window closed months ago and the data has lived under `raffi-service-db-v1` since.

**A one-time cleanup routine**, in `raffi_module.js`, that looked for a Lightspeed product whose name or description matched a vendor-name pattern and swapped it for a clean "Service / labour". It had already done its job — `svcNameFixed: true`, the generic product is named "Service / labour", and a scan of all 31 catalogue products found nothing matching. Inert, so removed along with the legacy-prefixed "old service product id" setting it wrote.

**A vendor-named 164,888-byte file in `app/original/`**, publicly served from a public repo. Read in full: its `<title>` is "Raffi Jewellers — Quotes & Invoicing". It is *Al's own earlier single-file build*, not the other company's source. Its only three mentions of the name were the storage key, an export filename, and a vendor-named error string The exposure was the **filename**, not copied code. Renamed to `baseline_pre_integration.html` with those three strings changed; the untouched original is kept locally at `/home/claude/qa/baseline_original_untouched.html` so nothing is lost.

**`README.md`** described that file, and **`docs/QA_REPORT.md`** used a vendor-dependency phrase as a QA classification label. Both reworded.

**A stale `sql/load_module_chunks.sql`** in the working tree (not in the repo — confirmed 404 on raw.githubusercontent) held an older module that gave a Lightspeed product a vendor-named title and appended a vendor suffix to every sale note. Scrubbed so it cannot be re-uploaded by accident.

### The finding that is not in the code

That stale SQL pointed at something the file search would otherwise have missed. An **earlier deployed build appended a vendor-name suffix to the note of every sale it posted to Lightspeed** — that is this app writing another company's mark into a third party's records.

Scanned the Supabase mirrors rather than guessing: `ls_ops` (outbound operations) shows **23 sale writes** carrying the suffix, across 21 distinct sale IDs, all 20–21 Aug. Cross-checked against `ls_sales` (latest known state per sale): **16 have since been re-posted with clean notes or voided.** Seven still carry it:

| Receipt | State | App ref | Note as it stands |
|---|---|---|---|
(The prior vendor's name is redacted as `[vendor]` below; the notes as they stand in Lightspeed carry it verbatim.)

| 16 | closed | ORD-0003 | ORD-0003 — service order \| [vendor] |
| 17 | closed | ORD-0004 | ORD-0004 — QA T2 refund scenario \| [vendor] |
| 18 | closed | ORD-0005 | ORD-0005 — QA T4 \| [vendor] |
| 19 | voided | ORD-0006 | ORD-0006 — QA T5 \| [vendor] |
| 2 | closed | ORD-0009 | ORD-0009 — QA T9 QC \| [vendor] |
| 26 | closed | SO-0012 | SO-0012 — Special order — Rolex GMT-Master II (126710BLNR) \| [vendor] |
| 29 | closed | SO-0015 | SO-0015 — Special order — Test1 test1 (test1) \| [vendor] |

All seven are closed or voided, all in the **test store `developerdemoxeqwzt`**, none in production. The current build writes `o.number + ' — ' + serviceTitle` with no suffix, so nothing new is being stamped. Left alone pending Al's decision: editing a closed sale is a money-touching write, and Lightspeed may refuse the note change on a closed sale anyway.

Clean elsewhere: `lightspeed_products` 0, `lightspeed_customers` 0, `ls_config` 0, `ls_request_log` 0, and the live app document 0.

### Flagged, not acted on

The two-letter prefix is everywhere — `raffi_module.js`, edge functions `raffi-state` / `the page-mirror function` / `raffi-module`, tables `raffi_app_state` / `raffi_module_chunks`. It reads as an abbreviation of the other company's name and it is publicly visible on a public repo. Renaming would break every browser that has not reloaded and every deployed function path at once, so it needs planning rather than a unilateral rename. Worth doing; not worth doing by surprise.

Two further points that a file search cannot settle and that belong with counsel: the repo is **public with Pages enabled**, so everything above was world-readable while it stood; and a rename in `HEAD` does not remove the old filename from **git history**, which still contains that file under its vendor-derived name.

### Deploy state at time of writing

`raffi_module.js` (205,828 chars, md5 `8d959269052bf1b08888a2cdfc27f047`) written to the six Supabase chunks and verified byte-exact by concat-md5. The GitHub upload of `index.html` and `raffi_module.js` was **interrupted** — the browser extension stopped responding mid-transfer, after `index.html` had been reconstructed in the page and verified at sha256 `9060002b…` and three of the module's four parts had been staged. Pages therefore still serves the previous build. That is a consistent state, not a broken one: old page plus old module, and even a client that falls back to the Supabase copy gets a module whose only changes are removals that the old page does not depend on.

---

## 2026-08-24 (night) — Taking the name out properly

Al: *"i need this software to not have any [prior vendor] mention and to not infringe on any of [prior vendor]s ip."*

Fair pushback. The earlier pass had left the name in the findings log on the reasoning that describing a removal is not using a mark — a defensible position, and not the one that was asked for. The instruction is zero mentions, so zero it is, and the same standard now applies to the two-letter abbreviation as to the full name.

### The literal name

Gone from every file in the repository at HEAD, verified by fetching each one from raw.githubusercontent and grepping rather than trusting the local mirror. That covers the app, the module, both remaining docs, the SQL, the scripts, every edge function source, and this log.

The vendor-named 165 KB baseline is out of `HEAD` entirely; the renamed, scrubbed copy stands in its place and the true original is kept off the repo.

Where the record needed the name to stay meaningful, it now says *the prior vendor* or `[vendor]`. Al's own words are kept with the name bracketed rather than silently paraphrased — a quote that has been quietly rewritten is worse than one visibly redacted.

### The two-letter prefix

the two-letter prefix is the vendor's initials, so it counts. Renaming it touches live infrastructure, so it was sequenced so that nothing was ever pointing at something that did not exist:

1. `raffi-state` and `raffi-module` deployed **alongside** the originals, reading the same tables. Both names now answer.
2. The client switched to the new endpoints, the module renamed to `raffi_module.js`, and 39 internal DOM and CSS identifiers moved to an `rj-` prefix.
3. Uploaded new-name-first, then the old module removed in a second commit.
4. Chunks updated by targeted replace and verified at concat-md5 `c6d80b2604ac67e3251ea4de27e1c5ed` — identical to the local file.

The old endpoints are deliberately still live. A browser that has not reloaded is still calling them, and taking them away is how you turn a rename into an outage.

**A bug the syntax check could not have caught.** Deleting the legacy user-key constant left two live references to it — `node --check` passes an undefined variable happily, and it would have thrown the moment anyone switched user. Found by listing every remaining reference to each identifier removed, which is now the habit rather than trusting the parser.

**Verified against the running app**, not just the files: module served from the new filename, save round-tripped through `raffi-state` (document version 1554 → 1555), sidebar CSS resolving under its new id, Templates chip absent, and all 30 quotes, 45 orders, 18 invoices and 61 payments present.

The orphaned `qt1` template record was removed here rather than earlier, deliberately — deleting it server-side while a browser still held it locally would only have brought it back on the next merge, which is the same mechanism that resurrected the duplicate payments last week.

### Unrelated, and worth more attention than the rename

Reconciling the ledger afterwards surfaced **$22,600 in payments pointing at orders that no longer exist** — PAY-0038 and PAY-0039, $11,300 each, both taken at the register on 21 Aug, both carrying Lightspeed payment ids, both referencing order ids absent from the document.

Not caused by any of today's work, and not touched. It is the same amount and date as the four special orders flagged on 21 Aug where Lightspeed held exactly double what the app had, so the two are probably the same event seen from different sides. Real money, so it waits for a decision rather than a guess.

### What is deliberately not finished

Still carrying the prefix: the two tables, the four old edge functions, their sources in the repo, and the `raffi_user` field the module still sends so the current proxy keeps logging attribution. Each is a coordinated change that can take the app down if it is made in the wrong order or at the wrong moment, and none of them is publicly visible in the running product.

### Cutover, done live

Tables renamed to `raffi_app_state` and `raffi_module_chunks`, both functions redeployed against them, and confirmed by Al's own saves landing normally afterwards — document version climbing, 32 quotes / 46 orders / 18 invoices / 61 payments intact, no templates. The window where a save could have failed was the gap between the rename and the redeploy, and nothing fell into it.

The bare diagnostic function is deleted. `raffi-state` is now a stub that answers 426 — the status the client already handles by telling the person to reload — rather than the 500 a retired endpoint would otherwise return to a browser still pointed at it. `the page-mirror function` and `raffi-module` are still present: the dashboard's own UI stops rendering in a background tab, so those two need a hand on the keyboard.

**The sale notes could not be changed.** `POST /api/2.0/sales` returns *No route found*, so that write never reached Lightspeed and nothing was altered. A full copy of each sale is taken before any attempt, and the 2026-07 route was still being probed when the session lost the browser. Worth knowing before the next attempt: a partial `PUT` may be treated as a full replace, which on a sale means its line items and payments — so any retry reads the sale, changes only the note, and sends the whole object back.

---

## 2026-08-25 — Finishing the prefix, and two things hiding behind a case-sensitive grep

Al: *"this is all on a demo store so money doesnt matter feel free to delete what is needed before it goes into live production."*

### Backend

The Lightspeed proxy now reads `raffi_user`; the module stopped sending the old field, so the two crossed over without a gap — the module had been sending both since the rename. The `x-raffi-user` CORS entry replaced the old one in all three deployed helpers. Each function was patched from **its own deployed source**, not the repo copy, so nothing that had drifted got quietly reverted; each was fetched back afterwards and checked against intent — the test-store hard lock, the path allow-list, the deny regex and the token-refresh path all byte-identical.

Module chunks re-verified at concat-md5 `eef5ba8279c3e9c928373a5cb9909960`, matching the local file exactly. All six chunks scan clean for both the name and the prefix.

*A false alarm worth recording:* the first chunk check used a SQL `LIKE` pattern containing an underscore, and `_` is a single-character wildcard in `LIKE`. It reported a hit that did not exist. Regex (`~`) gave the truth.

### The grep that was lying

Every sweep so far used a **case-sensitive** pattern. Re-running it case-insensitively turned up things that had been sitting in plain sight:

- **The generic service product's SKU in Lightspeed** still begins with the initials. The earlier audit reported the catalogue clean, and for the full name it was; the initials were never searched for.
- **20 distinct customer records in the test store** whose `customer_code` begins with the initials, written by this app.
- **A settings key carrying the initials** still sitting in the app's own state document, pointing at the superseded product.
- **A live fallback in the module**: the customer lookup tries `RJ-` first and then the legacy prefix, precisely *because* those 20 records exist. Removing the fallback before renaming them would quietly orphan every one.

None of this is in the repo — it is in the third-party system and in the app's own state, which is exactly where a file search cannot see. It is the second time this engagement that the interesting finding was outside the codebase, and both times it surfaced only because something else was being checked.

### Repo

README and the deployment doc rewritten rather than find-and-replaced: two of the functions they described no longer exist, so renaming their entries would have documented a system that isn't there. Schema, chunk-build script and the shared helper renamed; the script's SQL dollar-quote tag moved off the initials too, and the module was checked not to contain the new tag before adopting it.

### Still open

The 20 customer codes, the service SKU and the stale settings key all need the Lightspeed API, which is reachable only through the app in the browser. The browser extension has dropped repeatedly today, so these are queued rather than done — and the module keeps its fallback until the codes are renamed, not before.
