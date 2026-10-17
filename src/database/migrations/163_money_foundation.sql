-- 163_money_foundation.sql
--
-- Phase 1 foundation: money that is recorded must be money that was received.
--
-- 1. A B2B "Place Order" (payment_method = B2B_CREDIT) used to be stamped payment_status = 'PAID' the moment it was
--    placed, although nothing had been collected. Every report that reads PAID as "cash in" (and the refund code,
--    which refunds PAID orders) was therefore wrong for these orders. From now on the order is PENDING until the
--    recorded settlements (order_b2b_settlements) cover its total, and only then PAID. This backfills existing rows
--    the same way. Only B2B credit orders that went through approval are touched.
--
-- 2. order_money: ONE definition of how much of an order has really been received, so reports stop re-deriving it.
--      B2B credit  → what the recorded settlements add up to
--      everything else → the full total once payment_status is PAID, otherwise nothing
--    wallet_part is the share paid from the customer's wallet (not cash and not gateway money).

UPDATE orders
   SET payment_status = CASE WHEN b2b_amount_settled + 0.01 >= total_amount THEN 'PAID' ELSE 'PENDING' END
 WHERE payment_method = 'B2B_CREDIT'
   AND b2b_approval_status IS NOT NULL
   AND payment_status IN ('PAID', 'PENDING')
   AND payment_status IS DISTINCT FROM CASE WHEN b2b_amount_settled + 0.01 >= total_amount THEN 'PAID' ELSE 'PENDING' END;

CREATE OR REPLACE VIEW order_money AS
SELECT o.id AS order_id, o.order_number, o.user_id, o.shop_id, o.payment_method, o.payment_status, o.status::text AS status, o.total_amount,
       CASE WHEN o.payment_method = 'B2B_CREDIT' THEN LEAST(o.b2b_amount_settled, o.total_amount)
            WHEN o.payment_status = 'PAID' THEN o.total_amount
            ELSE 0 END AS received_amount,
       CASE WHEN o.payment_method = 'B2B_CREDIT' THEN GREATEST(o.total_amount - o.b2b_amount_settled, 0)
            WHEN o.payment_status = 'PAID' THEN 0
            WHEN o.status::text = 'CANCELLED' THEN 0
            ELSE o.total_amount END AS outstanding_amount,
       LEAST(o.wallet_amount_used, o.total_amount) AS wallet_part
  FROM orders o;
