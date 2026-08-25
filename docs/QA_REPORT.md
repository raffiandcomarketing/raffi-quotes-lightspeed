# Raffi Quotes & Invoicing — Deposit & Special-Order QA Report

**Store:** `developerdemoxeqwzt` (Lightspeed X-Series developer TEST store — production never touched)
**Period:** Aug 18–21, 2026 · **Prepared for:** Al (Raffi & Co)
**Rendered version:** https://claude.ai/code/artifact/cd040176-3654-49ed-bf02-8082b46bea31

## Verdict: **GO — WITH CONDITIONS**

Every deposit path posts to Lightspeed as an open layaway (`pending · layby,service`) and is
recognised only at completion/pickup. 24 scenarios verified; 4 defects found, all fixed and
retested; the unearned-revenue identity reconciles to the cent with zero violations.

**The cardinal rule under test:** a service deposit must never be counted as a sale when taken.
It is unearned revenue (a liability) until the service is completed *and* paid in full — and for
special-order merchandise, even **full prepayment** stays a layaway until the client picks the
piece up. This held on every order, in the app, in the Lightspeed API, and in the store's own
Sales History.

## Test summary

Installed + authorized via OAuth in the test store; configured outlets/registers/taxes/payment
types/users; exercised end-to-end via UI with every Lightspeed effect verified via API and the
native Sales History. Coverage: single/multiple deposits, overpayment block, final+close, refunds
on open laybys, cancellation (fee / full refund / net-zero void), roles + PIN, idempotency +
double-submit, invoice routing, ON/QC taxes, inventory commit + hard blocks (stock, brand,
serialized), delete/status guards, reconciliation, webhooks, shared-state persistence, and the new
**Special Orders** section (SO numbering, brand/model/reference/ETA, statuses Ordered → With
supplier → Arrived → Picked up).

Change requests delivered this cycle: sidebar open by default with titles; sale attributes
`["layby","service"]` (matches the requested `pending | layby,service` state); Special Orders
section on the side menu.

## Defects found → fixed → retested

| # | Severity | Defect | Root cause | Fix | Retest |
|---|----------|--------|-----------|-----|--------|
| 1 | **HIGH** (T-SO-1) | "Credit Card" deposit posted to LS as **Store Credit** → LS 400 `ensuring store credit customer … not found`; sale not created; payment held locally with Retry | Auto-mapper regex `/credit/i` matches "Store Credit" before "Credit Card" (Gift Card had same defect). Latent day one because all prior tests paid Cash | Store Credit excluded from auto-mapping entirely; exact-name match first; Gift Card→Cash fallback; self-healing of poisoned mappings on sync | Retry posted $3,000 as real Credit Card on receipt #26. Never misbooked revenue — failure mode was a blocked deposit, not a booked sale |
| 2 | **BLOCKER** | OAuth `redirect_uri` generated as `http://` behind proxy — token exchange would fail exact-match | Edge function sees itself as http behind Supabase proxy | Force https in callback (oauth v3) | Full OAuth round trip OK |
| 3 | MEDIUM | "Complete & close if paid in full" checkbox didn't register clicks | Original app's document-level click handler preventDefaults bubbled clicks + CSS stretched input full-width | Click-shielded label + explicit sizing | One-step close verified (ORD-0009) |
| 4 | LOW | Proxy forwarded JSON `null` body on GET | Body not normalised | null→no body; never forward body on GET (proxy v3/v4) | Probe clean; all 6 historical failures were this |

## Test matrix (condensed — full detail in findings_log.md)

| Test ID | Function | Expected | Actual | Result |
|---------|----------|----------|--------|--------|
| T-OAUTH-1 | Install/authorize | Connected, test store locked | Connected (after https fix) | PASS |
| T-DEP-1 | First deposit | LS sale `pending·layby`, not a sale | Receipt #16, history "Layaway" | PASS |
| T-DEP-2 | Second deposit | Same sale accrues | Payments [20,10], open | PASS |
| T-OVR-1 | Overpayment | Blocked pre-API | Blocked client-side | PASS |
| T-FIN-1 | Final + close | Closed; revenue only now | Closed, INV auto-created | PASS |
| T2 | Refund on open layby | Negative payment, same sale | [50,−20] pending | PASS |
| T3 | Cancel + fee | Only fee recognised | Closed at $10 fee | PASS |
| T4 | Cancel full refund | Nothing recognised | Closed $0, [25,−25] | PASS |
| T5 | Cancel net-zero | Voided | Receipt #19 VOIDED | PASS |
| T6 | Roles + PIN | Associate limited, audited | Denials + audit rows | PASS |
| T7 | Idempotency | No duplicates | Replays flagged; lock holds | PASS |
| T8 | Invoice routing | Payment → service order flow | ORD-0010 auto-created | PASS |
| T9 | Taxes ON/QC | Exact line tax | 113.00 / 229.95 to the cent | PASS |
| T9b | Paid-in-full ≠ done | Stays open layaway | #21 pending, to_pay 0 | PASS |
| T10 | Stock/brand/serialized | Hard blocks | All blocked with reasons | PASS |
| T10g | Inventory commit | Deducted at layaway | 5→4 at Cambridge | PASS |
| T11 | Delete guards | Blocked with history | All blocked | PASS |
| T13 | Status guards | Illegal transitions refused | Balance-due + terminal locks | PASS |
| T12 | Reconciliation | Identity, 0 violations | Holds (below) | PASS |
| T-SO-1 | Special order deposit | Card tender on layaway | Bug found→fixed→retested (#26) | PASS |
| T-SO-2 | Multiple deposits (SO) | Same sale accrues | [3000,5000] pending | PASS |
| T-SO-3 | **Full prepay ≠ sale** | Open layaway at $0 balance | `pending·layby,service`, to_pay 0 | PASS |
| T-SO-4 | Pickup close | Recognised at pickup | "Layaway – completed #26", INV-0004 | PASS |
| T-WH-1 | Webhooks | Events received | `active:true` required (422 else); 10 delivered, hours-scale lag | PASS |
| T-PERSIST | Shared state | Cold boot restores | Server doc v49→v71 | PASS |

## Unearned-revenue reconciliation (Aug 21, 14:30 ET)

**Identity: cash received = recognised + liability**
**CA$16,217.35 = CA$16,049.35 + CA$168.00 — HOLDS, 0 violations, 10 orders, 19 payments**

| Order | Kind | App status | LS state | Rcpt | Value | Paid | Recognised | Liability |
|-------|------|-----------|----------|------|-------|------|-----------|-----------|
| ORD-0003 | Service | Completed | closed·layby | 16 | 45.90 | 45.90 | 45.90 | 0 |
| ORD-0004 | Service | Cancelled (fee) | closed at fee | 17 | 100.00 | 10.00 | 10.00 | 0 |
| ORD-0005 | Service | Cancelled (refund) | closed $0 | 18 | 60.00 | 0.00 | 0.00 | 0 |
| ORD-0006 | Service | Cancelled (net-0) | voided | 19 | 80.00 | 0.00 | 0.00 | 0 |
| ORD-0007 | Service | Open | pending·layby | 20 | 50.00 | 35.00 | 0.00 | 35.00 |
| ORD-0008 | Service | Open (paid in full) | pending·layby | 21 | 113.00 | 113.00 | 0.00 | 113.00 |
| ORD-0009 | Service | Completed (QC) | closed·layby | 2 | 229.95 | 229.95 | 229.95 | 0 |
| ORD-0010 | Service | Open (no deposit) | not posted | — | 75.00 | 0.00 | 0.00 | 0 |
| ORD-0011 | Service | Open (part committed) | pending·layby | 22 | 42.00 | 20.00 | 0.00 | 20.00 |
| SO-0012 | **Special** | Picked up | closed·layby,service | 26 | 15,763.50 | 15,763.50 | 15,763.50 | 0 |
| **Totals** | | | | | **16,559.35** | **16,217.35** | **16,049.35** | **168.00** |

API ⇄ UI cross-check: dashboard tiles match API figures; mirror `ls_sales` 12 sales consistent
(3 QA probe sales voided, receipts 23–25); 48 idempotent ops; 125 API calls, all 21 failures
accounted for (QA probes + the two fixed defects). Native Sales History never showed a deposit as a
plain completed sale. Anti-pattern receipt #4 (day-one documentation of the failure mode) remains
as the counter-example.

## Findings classified

| Finding | Classification |
|---------|---------------|
| Card tender mapped to Store Credit (T-SO-1) | **App bug** — fixed |
| OAuth http redirect_uri | **App bug (backend)** — fixed |
| Complete-checkbox unclickable | **App bug** (inherited from original UI) — fixed |
| Proxy GET null-body | **App bug (backend)** — fixed |
| Layby + store-credit payment requires customer credit account (LS 400) | **Lightspeed platform behaviour** (correct) |
| Webhook registration requires `active:true` | **API requirement** (under-documented) |
| Webhook delivery hours-scale lag | **Lightspeed platform limitation** — app not webhook-dependent |
| Search eventually consistent | **Lightspeed platform behaviour** |
| No "Wire" payment type in store (maps to E-transfer) | **Configuration decision** |
| Store-credit / gift-card tender flow | **Business-process decision** — deliberately unmapped |
| Supabase rewrites HTML→plain text (UI on GitHub Pages) | **Supabase platform limitation** |
| Global click handler / full-width inputs | **Legacy base-page dependency** — worked around |

## Conditions before production

1. **Add authentication** — app URL + anon key currently grants use (test store only, enforced
   server-side). Put UI behind login, scope the proxy per-user, rotate the anon key.
2. **Keep sync/polling as source of truth** — webhooks deliver with hours-scale lag in dev; measure
   in production before depending on them.
3. **Cutover checklist** — re-point allowed store prefix (deliberate hard-lock today), re-run OAuth
   on production store, re-map outlets/registers/taxes/payment types in Settings and re-verify the
   payment-mapping table (one screen; prevents the T-SO-1 class).
4. **Decide store-credit / gift-card process** — the app will never auto-select Store Credit.
5. **Trial store expiry** — 27 days left on the dev store.

---
*Evidence: LS receipts #16–26 · repo raffiandcomarketing/raffi-quotes-lightspeed · module sha
4a20a7ec… · full running log in docs/findings_log.md · screenshots delivered in chat.*
