-- 153_validate_stock_movements_type.sql
--
-- Second half of migration 151's widened stock-movement type rule: check the existing rows. Done as its own migration
-- (= its own transaction) because VALIDATE CONSTRAINT only takes a lock that lets orders keep writing stock movements,
-- whereas doing it inside 151 would have kept the table fully locked for the whole scan.
-- Safe to re-run: validating an already-valid constraint does nothing.
ALTER TABLE stock_movements VALIDATE CONSTRAINT chk_stock_movements_type;
