/**
 * The ONE definition of "a sale", "a cancellation" and "a refund" for every money screen (Overview, Business Analytics,
 * store scorecards). Both dashboards build their SQL from these fragments, so they can never disagree.
 *
 * Rules
 *  - PLACED: the order really happened — not still waiting for payment, not cancelled. An order that was cancelled and
 *    later "refunded" (the refund flow flips CANCELLED → REFUNDED) is still a CANCELLED order, not a sale.
 *  - Refund: money handed back, counted once per order on the day it was refunded. Source, in order of trust:
 *    approved refund request → gateway refund on the payment → (older/admin wallet refunds that left no amount behind)
 *    what the customer paid in cash/online = total − wallet used, dated by the REFUNDED status change.
 *  - Fully refunded: the refund covers everything the customer paid, so the order is not a real sale any more.
 */

const aliasCh = (a) => `(CASE WHEN ${a}.buyer_gstin IS NOT NULL OR ${a}.b2b_approval_status IS NOT NULL THEN 'B2B' ELSE 'B2C' END)`

/** B2B = placed by a business account; everything else B2C. */
export const CH = aliasCh('o')
export const channelOf = aliasCh

const wasCancelled = (a) => `EXISTS (SELECT 1 FROM order_status_history hc WHERE hc.order_id = ${a}.id AND hc.to_status = 'CANCELLED')`

/** Cancelled right now: plain CANCELLED, or REFUNDED after having been cancelled (money went back, sale never stood). */
export const cancelledAs = (a = 'o') => `(${a}.status = 'CANCELLED' OR (${a}.status = 'REFUNDED' AND ${wasCancelled(a)}))`
export const placedAs = (a = 'o') => `(${a}.status NOT IN ('PENDING', 'CANCELLED') AND NOT (${a}.status = 'REFUNDED' AND ${wasCancelled(a)}))`

export const PLACED = placedAs('o')
export const CANCELLED = cancelledAs('o')
export const DAY_IST = `((o.created_at AT TIME ZONE 'Asia/Kolkata')::date)`

/**
 * CTE text (no leading WITH) giving one row per refunded order: refund_events(order_id, amt, at, is_full).
 * Join it to `orders o` and filter with PLACED / dates as needed.
 */
export const REFUND_EVENTS_CTE = `refund_events AS (
  SELECT o.id AS order_id, ev.amt, ev.at,
         (ev.amt > 0 AND ev.amt >= GREATEST(o.total_amount - COALESCE(o.wallet_amount_used, 0), 0) - 0.01) AS is_full
    FROM orders o
    LEFT JOIN (SELECT order_id, SUM(refund_amount) AS amt, MAX(processed_at) AS at FROM refund_requests
                WHERE status = 'APPROVED' AND refund_amount IS NOT NULL GROUP BY order_id) rq ON rq.order_id = o.id
    LEFT JOIN (SELECT order_id, SUM(refund_amount) AS amt, MAX(updated_at) AS at FROM payments
                WHERE refund_amount > 0 GROUP BY order_id) py ON py.order_id = o.id
    LEFT JOIN LATERAL (SELECT MAX(changed_at) AS at FROM order_status_history hr WHERE hr.order_id = o.id AND hr.to_status = 'REFUNDED') hs ON TRUE
    CROSS JOIN LATERAL (SELECT COALESCE(rq.amt, py.amt, CASE WHEN o.status = 'REFUNDED' THEN GREATEST(o.total_amount - COALESCE(o.wallet_amount_used, 0), 0) END) AS amt,
                               COALESCE(rq.at, py.at, hs.at, o.updated_at) AS at) ev
   WHERE rq.order_id IS NOT NULL OR py.order_id IS NOT NULL OR o.status = 'REFUNDED')`
