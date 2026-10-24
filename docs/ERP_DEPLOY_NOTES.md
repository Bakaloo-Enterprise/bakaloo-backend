# Operations ERP — deploy notes (NOT deployed yet)

## Migrations (additive only, run in order)
| # | What |
|---|------|
| 169 | `feature_flags` row `erp` (starts LOCKED), `products.target_margin_pct`, `products.target_wastage_pct` (nullable) |
| 170 | `erp_expenses`, `erp_cash_entries` (never deleted — voided with a reason) |

Take a `pg_dump` first as usual. Nothing is rewritten; no existing column changes.

## The Overview numbers change — tell the team before deploying
The Dashboard / Command Center used `payment_status = 'PAID' AND status != 'CANCELLED'`. That counted **refunded orders as
sales** (an approved refund flips the order to `REFUNDED` but leaves it "PAID"), ignored part-refunds, used rolling 24h/7d
windows instead of India calendar days, and left out COD and business-credit orders until paid. It now follows the same
rules as Business Analytics (`business-analytics/sales-rules.js`):

* a sale = an order that was placed and not cancelled / unpaid (a cancelled-then-refunded order is a cancellation, not a sale);
* "Money kept" = sold − refunds (refunds dated by the day they were paid back);
* an order refunded in full is not counted as an order;
* Today / 7 days / 30 days / Year are India calendar days, compared with the equal period before;
* COD and approved B2B credit orders count as sales when placed (money received is a different figure);
* "Pending orders" now means orders waiting to be accepted (it showed the period's order total before);
* Best sellers count real quantities (it counted order lines before) and follow the selected period.

Expect revenue and order counts to **drop** versus the old screen on days with refunds/cancellations, and to **rise**
for COD / B2B credit sales that used to be left out until paid.

## Feature lock
All `/api/v1/admin/erp/*` routes and the `/erp/*` screens are behind feature `erp` (like Procurement): only developers
or people granted access can open them until a developer releases the feature on the Developer page.
The Command Center itself is not locked.

## Permissions
* Read screens: `analytics.business` (HQ super admin / admin always pass).
* Record expenses / cash entries / wastage, change targets: `procurement.manage`.
* A store-level user is pinned to their own store and cannot open accounting, founder view, expenses or targets.

## Rollback
Code: redeploy the previous release (the new tables are simply unused). Data: nothing to undo — expenses and cash
entries are additive.

## Quick buy (Procurement → To buy) — no migration
* `GET /admin/procurement/plan` items gain `vendors` (up to 4 suppliers we usually buy that product from, newest first, each with the latest price) and `lastVendorId`. The "last paid" hint now skips suppliers that have been closed.
* `GET /admin/procurement/payables` vendors gain `usually` (the 3 products bought most) and `lastBoughtOn`.
* Dashboard only: tapping a To-buy card opens a pre-filled purchase; "Add to buy list" keeps a list in the browser (localStorage, not shared) grouped by supplier, with a WhatsApp order message and one-tap "record as on the way". Purchases themselves still go through the existing `POST /procurement/entries`.
* Both API additions are additive; older dashboards ignore the new fields.

## Reports (HQ `/admin/reports/*` and store `/shop-reports/*`) now use the same sales rules — no migration
Code: `src/modules/reports-shared/sales-reports.js` (one set of queries for both), on top of `business-analytics/sales-rules.js`.
Tests: `tests/integration/reports-sales.db.test.js` (hand-worked day), plus HTTP smoke in `overview-http.db.test.js`.

| Report | Before | Now |
|---|---|---|
| GMV | every order, incl. cancelled and unpaid; UTC days | orders that stood, before refunds; India days |
| Orders | status counts; a cancelled-then-refunded order showed as "Refunded" | same, but it shows as "Cancelled"; paging counts the right groups |
| Revenue | "gross" = every order; "refunded" = full total of orders marked Refunded (even part refunds and cancelled ones); "net" counted cancelled and unpaid orders | sold = orders that stood; given back = real refund amounts on the day paid back; kept = sold − given back; new `orders` column |
| Refunds | whole order total of Refunded orders, on the order's day | real refund amount on the day it was paid back; cancelled orders are not refunds; new `full_refunds` column |
| Shop performance / Top shops | revenue and orders included cancelled and unpaid | orders that stood; revenue = money kept |
| Top products | quantity from every order | orders that stood (not cancelled, unpaid or refunded in full) |
| Coupon usage | included cancelled orders' coupons | orders that stood only |
| Rider performance | every order with a rider, even cancelled | deliveries made in the period (by delivery day) |
Not changed: Low stock, Payouts, Customer acquisition, store Staff activity and Settlement.
Invalid dates (e.g. 2026-02-30) are now a 400 instead of a database error. Reports stay cached for 5 minutes.

## Analytics page (`/admin/analytics/*`) now uses the same sales rules — no migration
Code: `src/modules/admin/analytics/analytics.repository.js` (on `reports-shared/sales-reports.js` → `business-analytics/sales-rules.js`); page `bakaloo-dashboard/src/app/(dashboard)/analytics/page.tsx`.
Tests: `tests/integration/analytics-sales.db.test.js` (17, hand-worked day). The two old mock tests that checked the old SQL text (`tests/unit/admin/analytics/shop-scoping`, `financial-report-gst`) were replaced by these.

| Part | Before | Now |
|---|---|---|
| Date range | End date left out (so **today was missing**); the page counted 31 days for "30D" and used the browser's date | End date included; "30D" = last 30 India days incl. today; previous period = the 30 days just before |
| Which orders | Delivered only: orders still being prepared or on the way were missing; a part-refunded order disappeared | Every order that stood (not cancelled, not unpaid, not refunded in full) |
| Revenue | Order total (no refunds taken off) | Money kept = sold − refunds, refunds on the day they were paid back; sold and refunds also returned |
| Financial "net" | total − coupon (coupon was subtracted twice; `total_amount` is already after the coupon) | sold − refunds |
| Days / weeks / months | UTC (night orders moved a day) | India time |
| Best sellers, GST, payment methods, tips, fees | Delivered orders, refunded ones included | Orders that stood |
| Customers & cohorts | Delivered only, UTC | Orders that stood, India months; cohort months are plain `YYYY-MM-DD` text |
| Compare periods | Delivered only; end days left out | Same rules, end days included |
| Areas (city) | Delivered only | Orders that stood; each order net of its own refund (by order date, so the total can differ slightly from the top card, which dates a refund on the day it was paid back) |
| Deliveries | Delivered-by-day in UTC | India day, include the whole end day |
| Dead stock | "Last sold" ignored the store; one row per store when many stores | "Last sold" for that store only (all stores: sold anywhere); stock added up per product |

On the 30-day demo data: sold ₹9,99,904 · refunds ₹33,979 · kept ₹9,65,925 · 2,713 orders — same as Command Center and Reports to the paisa. Before: ₹9,47,448 and 2,623 orders (missing today and all orders still in progress, refunds not taken off).
Invalid dates are a 400. The Excel/PDF exports use the same labels (Sold before refunds, Refunds, Money kept, Orders that stood).

## HQ and store dashboards now use the sales rules — no migration
Code: new `src/modules/shop-dashboard/` (`GET /api/v1/shop-dashboard`), `GET /api/v1/shop-products/low-stock-count`, `shops.service.js` + `shops.repository.js` (`salesTotals`), `admin/dashboard/dashboard.repository.js` (pending actions); pages `hq/dashboard`, `store/dashboard`, `store/orders`, `components/dashboard/PendingActions.tsx`.
Tests: `tests/integration/store-dashboard.db.test.js` (10, hand-worked day). New routes sit under the permission audit (`shop_orders.view`) and are pinned to the caller's own store (HQ must send `X-Shop-Id`).

| Screen | Before | Now |
|---|---|---|
| Store dashboard (`/store/dashboard`) | Called `/shop-dashboard`, which did not exist: the page always showed a red error | Works: today's orders and money kept (orders that stood, refunds taken off), new orders to accept, low stock, products, average order (30 days), last 10 orders |
| Low-stock badge (store dashboard + Inventory page) | Called `/shop-products/low-stock-count`, which did not exist (it was read as a product id and failed) | Works; same rule as the Inventory list "low stock" filter |
| Shops list, HQ shops, shop page: "Total orders", "Total revenue" | Read stored counters that nothing ever updates, so **every shop showed 0** | Live lifetime numbers: orders that stood, money kept. On demo data the three stores add up to the HQ total (6,369 orders, ₹24,00,116.91) |
| Sidebar Orders badge and "Pending orders" card | Counted orders waiting for payment (not real orders; the store cannot act on them) | Orders waiting to be accepted (same as "new orders" on the Command Center). Waiting-for-payment is returned separately as `awaiting_payment` |
| HQ dashboard strip | Numbers were already on the sales rules, but the up/down arrow shown under **Total Revenue / Total Orders** was today-vs-yesterday | The arrow now sits under Today's Revenue / Today's Orders; labels say "after refunds", "not cancelled or refunded", "Customers who bought", "New orders to accept" |
| Store orders page | Ignored `?status=` in the link | Opens already filtered (the dashboard card links to `?status=CONFIRMED`) |

Not changed on purpose: HQ Finance / store Financials / settlement payouts. They are payout money (delivered orders by delivery day, subtotal-based commission) and follow the settlement rules, not the sales rules. Changing them changes what shops are paid, so that needs a separate decision.
