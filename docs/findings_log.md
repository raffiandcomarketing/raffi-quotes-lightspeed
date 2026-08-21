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

## 2026-08-19 (cont.) — GitHub project + hosting
- Repo raffiandcomarketing/raffi-quotes-lightspeed populated via GitHub web upload (13 upload commits + README init; container git creds are bound to other repos). Tree: README, .gitignore, app/{index.html,qm_module.js,original/}, supabase/functions/{_shared,lightspeed-oauth,lightspeed-api,lightspeed-webhook,qm-state,qm-app,qm-module,qm}, sql/schema.sql, scripts/build_module_chunks.py, docs/{findings_log.md,DEPLOYMENT.md}.
- Al approved: repo public + GitHub Pages; visibility flip pending GitHub sudo-mode email verification (only Al can complete).
- LS_CLIENT_SECRET: walkthrough sent to Al (LS dev portal → Supabase Edge Function secrets).

## 2026-08-20 — Pages live, app boots, OAuth bug fix
- Repo made public by Al; GitHub Pages enabled (main / root). App UI live at
  https://raffiandcomarketing.github.io/raffi-quotes-lightspeed/app/ — boots clean (no console errors),
  module active (liability/balance/revenue/LS cards, user switcher), migration applied, shared server
  state now persisting (qm-state doc v1).
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
  Al ↔ LS user linked; QM-SERVICE product + No Tax id resolved.
- T-DEP-1 PASS: $20 deposit on ORD-0003 → LS sale created state=pending attrs=["layby"] receipt #16,
  payment posted w/ client UUID (idempotent), customer auto-created (QM-c4), native history shows
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
  Fix (qm_module.js syncRef): Store Credit is excluded from auto-mapping entirely (exact-name match first,
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

**Al's requests.** Remove every "QuoteMachine" mention; a special order must post its Lightspeed
line as **Special Order Product** with **Brand + Model + Reference in the note**, still unearned
revenue; when **inventory receives** the piece the line must switch to the **actual product under
the Raffi ID generated in Salesforce**; Quotes/Orders/Invoices move below Special Orders in the
menu. Mid-build Al hit a real register trap on SO-0022: tendering the FULL amount auto-completes
the sale (Layaway is only offered while a balance remains) — premature revenue.

**Built.**
1. **De-branding** — sale notes now `SO-00xx — Special order: BRAND MODEL Ref. X` / `ORD-00xx —
   <service title>` (no "| QuoteMachine"); the generic service product could NOT be renamed
   (2026-07 products PUT rejects name/variant_name/active: "Unknown field in payload" — platform
   limitation), so the app swapped to a clean **Service / labour** product (sku RAFFI-SERVICE),
   re-pointed all open sales on re-sync, and deleted the old QuoteMachine-named product (proxy v5
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
  note "SO-0023 — Special order: … — S/N WS445102". No "quotemachine" anywhere on any open sale.
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
