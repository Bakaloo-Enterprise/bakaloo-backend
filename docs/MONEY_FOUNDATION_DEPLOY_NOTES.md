# Money foundation — what changes when this is deployed

Migrations **163** (money foundation) and **164** (staff-added customers). Nothing here is deployed yet.

## The one behaviour change that moves numbers

A B2B "Place Order" (payment_method `B2B_CREDIT`) used to be stamped `payment_status = 'PAID'` the moment it was
placed. It is now `PENDING`, and becomes `PAID` only when the recorded B2B settlements cover the order total.
Migration 163 applies the same rule to existing B2B credit orders that went through approval:
`PAID` stays only where `b2b_amount_settled >= total_amount`, everything else becomes `PENDING`.

## Numbers that change (every query that reads `payment_status = 'PAID'`)

All in `src/modules/admin/dashboard/dashboard.repository.js` (the Dashboard / HQ Dashboard screens):

| Screen figure | Query | What changes |
|---|---|---|
| Dashboard stats → **Revenue** (this period, vs previous period, % change, sparkline) | `_revenueStats` | B2B credit orders count only once fully paid |
| HQ KPI strip → **Total revenue, Total orders, Average order value, Total customers, Pending orders** | `getKpis` | All five are computed over PAID orders only, so every one of them drops by the unpaid B2B credit orders. "Pending orders" also stops counting B2B orders waiting for approval (they were counted only because they were PAID) |
| Revenue chart → **Daily orders, revenue, average order value, COD revenue** | `getRevenueChart` | Unpaid B2B credit orders disappear from their day |
| **Category revenue** (last 30 days) | `getCategoryRevenue` | Same |

Also:

* **Wallet → Credit Wallet dialog**, "recent paid orders": a B2B credit order is listed only once fully paid.
* **Orders list**: the "Payment status" filter and the CSV/Excel export column — B2B credit orders move from *Paid* to *Pending* until settled.
* **B2B → GST invoices** page: the payment badge shows *Pending* until the order is fully settled.
* **Order drawer bill, customer-app order detail / order success screen, invoice PDF, POS print**: the B2B credit line reads
  "On credit (B2B) — Pending" instead of "Paid". Nothing is asked of a rider (cash-on-delivery amounts only apply to COD).
* **Refunds**: admin Refund and the refund inside Cancel now refuse B2B credit orders (nothing was ever paid through the
  gateway or wallet, so an automatic refund would have created wallet money from nothing).

## Not affected (checked)

Business Analytics, admin Analytics (`/admin/analytics/*`, delivered-order based), shop finance / payouts / commissions /
settlements, WhatsApp CRM analytics, procurement reports, the Month report, POS (only reads `FAILED`), the payment-expiry
and abandoned-cart workers (they act only on ONLINE/WALLET orders or orders with a pending gateway payment row — B2B credit
orders are neither), and the old `admin.repository.js` dashboard/sales/order stats (not routed, not called by the dashboard).

## Known gap, not touched

Store-staff refund (`shop-orders/service.js#refund`) does not check `payment_status` at all and only records status
`REFUNDED`; it was already like this.

## Measure the effect on production before deploying (read-only)

```sql
-- Orders whose payment_status will change from PAID to PENDING, and the revenue that drops out of the PAID-based figures
SELECT date_trunc('month', created_at AT TIME ZONE 'Asia/Kolkata')::date AS month,
       COUNT(*)                                   AS orders,
       SUM(total_amount)                          AS leaves_paid_revenue,
       SUM(total_amount - b2b_amount_settled)     AS still_to_collect
  FROM orders
 WHERE payment_method = 'B2B_CREDIT'
   AND b2b_approval_status IS NOT NULL
   AND payment_status = 'PAID'
   AND status <> 'CANCELLED'
   AND b2b_amount_settled + 0.01 < total_amount
 GROUP BY 1 ORDER BY 1;
```

## Option to keep the headline revenue steady

If the owner wants dashboards to keep counting approved B2B credit sales as sales (accrual) while "paid" means cash, change the four
dashboard queries above from `payment_status = 'PAID'` to
`(payment_status = 'PAID' OR (payment_method = 'B2B_CREDIT' AND b2b_approval_status = 'APPROVED'))`. Cash received is reported
separately in the Month report ("All money really received") and the `order_money` view.

---

# Profit, stock value and month closing (migration 165)

Local only until deployed. Adds three tables (`accounting_periods`, `period_stock_snapshots`, `accounting_period_log`) and nothing else
in the database; no existing row is changed.

## What it does
* **Stock value** — shelves at moving-average cost replayed from `stock_movements`; warehouse (bought, not yet on a shelf) at each
  purchase's own price. Opening stock is **estimated** (today's `cost_price`) until the month before is closed.
* **Cost of goods sold and profit** — sales and cost come from the same stock events, so they always cover the same goods;
  cancelled/returned orders take their sale and cost back. Channel (home / business) split, margin by product and by store.
* **Wastage** — shelf damage + write-offs + goods thrown away at the door are losses; goods sent back to a supplier are not.
* **Checks** (shown before closing): stock record vs stock history, warehouse-to-shelf transfers, roll-forward (opening + in − out = closing).
  The first three block closing.
* **Month closing** — freezes the report and Excel, stores closing stock as the next opening, writes a log. Only a finished month, in
  order; reopen the latest only, with a reason.

## Behaviour changes to know about
* After a month is closed, **a purchase dated in it, a supplier payment dated in it, cancelling a purchase from it, or cancelling a payment from it is refused**
  ("falls in 2026-09, which is closed").
* In the month report, a supplier bill is dated **when the goods were received** (not when ordered), so an order placed in one month and
  received in the next is billed in the next. (The Suppliers screen still shows its own due dates from the order date.)

## Not included in profit
Delivery cost, store commission, payment-gateway fees, GST and running costs are not recorded in the system, so profit is gross
profit on goods. Sales are at item prices, before coupons and fees. A customer return or cancellation is valued at the average cost
at the time of the return (not the original cost).

## Run before relying on a number
`MONEY_DB_TEST=1 npx vitest run tests/integration/valuation.db.test.js tests/integration/money-foundation.db.test.js` (19 tests, real database).

---

# Packs, request → order, store transfers (migrations 166, 167, 168)

All three are additive. Deploy order for everything not yet on the server: **165 → 166 → 167 → 168** (after 159–164).

## 166 — weight-based stock / repacking
* `products.pack_size` + `pack_unit` (G or ML). The migration fills them from `net_quantity` where it reads like "500 g", "1 kg", "250ml",
  "1.5 L" (multi-packs such as "2 x 500 g" are left empty). Staff can fix any product from the Make-packs screen.
* A repack uses whole units of a bulk purchase and makes packs of the **same product family** (never the bulk product itself), landing on one
  store's shelf. Grams in = grams out + a recorded loss; pack cost = cost per gram × pack weight. Undo is possible only while every pack is unsold.
* Only the **pre-packed** mode is built. Selling 500 g and 1 kg from one shared loose stock is not.

## 167 — a customer request becomes an order
* `b2b_requirements.order_id`. "Make order" on a "Sure" request opens Create Order filled in; placing the order marks the request Delivered
  **in the same transaction**. A request that has stock held for it in the warehouse is delivered with "Delivered" instead (that uses the held stock).

## 168 — store transfers "on the way"
* `procurement_allocations` gets status `IN_TRANSIT` / `CANCELLED`, `applied_at`, `received_by`. Existing rows: `applied_at = created_at`.
* Sending "on the way" takes the units out of the purchase's free stock but not onto the shelf; the store confirms what arrived
  (fewer = the rest is written off as lost on the way); a transfer that never left can be cancelled.
* Goods on the way still count as ours in stock value (shown separately); the warehouse-to-shelf check now uses the moment stock became saleable.

## Tests (opt-in, real database — run them one file at a time)
`MONEY_DB_TEST=1 npx vitest run --no-file-parallelism tests/integration/transfers.db.test.js tests/integration/repack.db.test.js tests/integration/valuation.db.test.js tests/integration/money-foundation.db.test.js`
(34 tests). They need an isolated database with every migration applied — never run them against production.
