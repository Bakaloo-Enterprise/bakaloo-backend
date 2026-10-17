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
