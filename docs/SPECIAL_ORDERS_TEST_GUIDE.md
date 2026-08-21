# Testing a Special Order with Three Payments — Help Doc

Start-to-finish walkthrough: create a special order, take **two deposits and a final payment**,
prove the sale stays a **layaway** in Lightspeed even when fully paid, then close it at pickup.

- **App:** https://raffiandcomarketing.github.io/raffi-quotes-lightspeed/app/
- **Store:** `developerdemoxeqwzt` (TEST only) · **Time:** ~10 minutes
- **Rendered version:** https://claude.ai/code/artifact/e7f1909d-5a1c-4176-99b4-76c78365789b

> **The rule you are testing:** deposits — one, several, or even 100% prepayment — post to
> Lightspeed as an open layaway (`pending · layby,service`) and are **never counted as a sale**.
> The sale is recognised only when the piece is picked up and you press **Complete & close**.

## Before you start

- [ ] Dashboard's Lightspeed tile says **Connected · developerdemoxeqwzt** (else Settings → Connect)
- [ ] Any user can take deposits; **Complete & close** needs advisor/manager/admin (top-right user
      switcher, PIN protected)
- [ ] Optional: open Lightspeed back office → **Sell → Sales history** in a second tab to watch the
      receipt change status live

**Worked example** (use these or your own; the final payment always pre-fills to what's left):

| Item | Amount | Method |
|---|---:|---|
| Watch price (before tax) | $10,000.00 | — |
| + HST 13% (Cambridge) | $1,300.00 | — |
| Payment 1 — deposit | $3,000.00 | Credit Card |
| Payment 2 — deposit | $4,000.00 | Debit Card |
| Payment 3 — final (pre-filled) | $4,300.00 | E-transfer |
| **Total collected before pickup** | **$11,300.00** | |

*This exact script was run live on `SO-0012` (Rolex GMT-Master II) — Lightspeed receipt `#26` in
the test store, if you want a finished example.*

## Part 1 — Create the special order

1. Left menu → **Special Orders** → **+ New special order** (top right).
2. Pick an existing customer, or leave "new customer" and type a **name** (email optional).
   A customer is required — Lightspeed laybys can't exist without one.
3. Fill the piece: **Brand** (Rolex), **Model** (GMT-Master II), **Reference**,
   **Price before tax** (10000), **Location** (Cambridge), **Expected arrival**, notes.
4. Click **Create & take deposit**.

**What you should see:** an order page `SO-####` with a gold **Special order** badge, item panel
"Special-order item (store merchandise · ETA …)", total **$11,300.00** — and the payment window
already open.

## Part 2 — Payment 1 of 3 (first deposit)

5. Change **Amount** from the pre-filled balance to **3000**.
6. **Method:** Credit Card · note "Deposit 1 of 3".
7. Leave **"Complete service & close sale …" UNCHECKED** → **Record payment**.

**What you should see:** toast "PAY-#### recorded — balance $8,300.00 · LS receipt #…"; header
badge **LS: Layaway (open) #…**; ledger shows the payment **Posted**.

**Verify in Lightspeed:** newest receipt shows your customer, note `SO-#### — Special order …`,
full $11,300.00 total, status **Layaway** — not Completed. The $3,000 is a deposit, not revenue.

## Part 3 — Payment 2 of 3 (second deposit)

8. On the order, click **Take deposit / payment** again.
9. Amount **4000** · Method **Debit Card** · note "Deposit 2 of 3" · checkbox unchecked →
   **Record payment**.

**What you should see:** balance **$4,300.00**; two posted payments in the ledger; in Lightspeed
it's the **same receipt** accruing both — still **Layaway**. Multiple deposits on one piece ✓.

## Part 4 — Payment 3 of 3 (paid in full — still not a sale)

10. **Take deposit / payment**. Amount is pre-filled with the exact remaining balance (**4300**) —
    leave it.
11. Method **E-transfer** (or Wire) · note "Paid in full before arrival".
12. **LEAVE THE CHECKBOX UNCHECKED** — the watch hasn't arrived or been picked up →
    **Record payment**.

**THE CRITICAL CHECKPOINT:** balance **$0.00**, yet the order is still **Open** and the badge
still says **LS: Layaway (open)**. In Lightspeed the receipt still reads **Layaway** — fully paid,
**zero revenue recognised**. The client's $11,300 is a liability (deposits held) until pickup.
*If you instead see "Layaway – completed" here, stop and report it — that would be a deposit
counted as a sale.*

Also: **Take deposit / payment** greys out (nothing left to pay), and the Dashboard's
"Deposits held — unearned revenue" tile is up by $11,300.

## Part 5 — Pickup day (recognise the sale)

13. Optional tracking while waiting: status → **With supplier** → **Arrived — awaiting pickup**
    (neither touches the money).
14. Client collects the watch → **Complete & close** → confirm (advisor+).

**What you should see:** status **Picked up**; badge **LS: Layaway – completed #…**; invoice
`INV-####` auto-created; completing user + timestamp stamped.

**Verify in Lightspeed:** the receipt now shows **"Layaway, completed"** — today the $11,300
becomes revenue, not the days the payments were taken.

## Final verification — the money adds up

- **Dashboard:** "Deposits held" down $11,300, "Recognised service revenue" up $11,300 at close.
- **Payments → Service deposit reconciliation:** the SO row shows Cash $11,300 · Recognised
  $11,300 · Liability $0 (while open it read Liability $11,300 · Recognised $0).
- **Lightspeed Sales history:** one receipt tells the whole story — three payments, Layaway
  throughout, completed only at the end.

## If something doesn't look right

| You see | What it means | What to do |
|---|---|---|
| "Payment recorded locally but Lightspeed sync failed … use Retry" | Payment saved in the app; only the push failed | Click **Retry** on that payment's ledger row — re-posts the same payment, never a duplicate |
| "Select a customer on the order first" | Laybys require a customer | Pick/create the customer, then deposit |
| "Overpayment is blocked" | Amount > remaining balance | Enter the balance or less (final payment pre-fills it) |
| Took the wrong amount | Deposits are corrected by refund, not editing | **Refund** (manager+) posts a negative payment to the same layaway |
| Client backs out before pickup | Cancellation decides the money | **Cancel service** → full refund (nothing recognised) or keep a fee (only the fee recognised) |
| "Complete & close" refuses | Balance ≠ $0, unsynced payment, or associate role | Clear balance / Retry unsynced payments / switch to advisor+ |

---
*Companion documents: `docs/QA_REPORT.md` and `docs/findings_log.md`. Everything here runs against
the TEST store only.*
