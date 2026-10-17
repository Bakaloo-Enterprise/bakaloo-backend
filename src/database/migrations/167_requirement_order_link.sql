-- 167_requirement_order_link.sql
--
-- A customer request ("Sure") can be turned into a real B2B order from the Create Order screen. The request keeps a link to
-- the order that fulfilled it and becomes DELIVERED in the same transaction as the order, so the two can never disagree.
-- (A request that has stock held for it in the warehouse is delivered with "Delivered" instead, which uses the held stock.)

ALTER TABLE b2b_requirements ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_b2b_req_order ON b2b_requirements (order_id) WHERE order_id IS NOT NULL;
