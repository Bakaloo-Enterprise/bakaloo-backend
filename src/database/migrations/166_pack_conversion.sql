-- 166_pack_conversion.sql
--
-- Weight-based stock: turn a bulk purchase into the pack sizes we sell (500 g, 1 kg…).
--
--   products.pack_size / pack_unit   how much one unit of this product holds: grams (G) or millilitres (ML).
--                                    Filled from net_quantity where it reads like "500 g", "1 kg", "250ml", "1.5 L"; staff can fix it.
--   procurement_conversions          one repacking: N whole units of a purchase used up, packs produced, grams lost on the way
--   procurement_conversion_lines     which pack product went to which store, how many, and at what cost per pack
--
-- Rules: stock stays whole units. A conversion uses WHOLE units of the bulk purchase; the packs made cannot weigh more than
-- that; the difference is a recorded loss (trimming, spillage), valued at cost. Cost per pack = cost per gram × pack weight, so
-- value is carried over exactly and profit on each pack size is real.

ALTER TABLE products ADD COLUMN IF NOT EXISTS pack_size INTEGER CHECK (pack_size IS NULL OR pack_size > 0);
ALTER TABLE products ADD COLUMN IF NOT EXISTS pack_unit VARCHAR(2) CHECK (pack_unit IS NULL OR pack_unit IN ('G','ML'));

UPDATE products p
   SET pack_size = ROUND(x.m[1]::numeric * CASE WHEN x.m[2] IN ('kg','kgs','l','ltr','litre','liter') THEN 1000 ELSE 1 END)::int,
       pack_unit = CASE WHEN x.m[2] IN ('ml','l','ltr','litre','liter') THEN 'ML' ELSE 'G' END
  FROM (SELECT id, regexp_match(lower(trim(net_quantity)), '^(\d+(?:\.\d+)?)\s*(kgs|kg|gms|gm|grams|gram|g|ml|ltr|litre|liter|l)$') AS m FROM products WHERE net_quantity IS NOT NULL) x
 WHERE p.id = x.id AND x.m IS NOT NULL AND p.pack_size IS NULL AND ROUND(x.m[1]::numeric * CASE WHEN x.m[2] IN ('kg','kgs','l','ltr','litre','liter') THEN 1000 ELSE 1 END) > 0;

CREATE TABLE IF NOT EXISTS procurement_conversions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entry_id    UUID NOT NULL REFERENCES procurement_entries(id),
  units_used  INTEGER NOT NULL CHECK (units_used > 0),
  unit_size   INTEGER NOT NULL CHECK (unit_size > 0),          -- grams / ml in ONE unit of the bulk purchase when it was repacked
  grams_used  INTEGER NOT NULL CHECK (grams_used > 0),
  grams_packed INTEGER NOT NULL CHECK (grams_packed > 0),
  grams_lost  INTEGER NOT NULL CHECK (grams_lost >= 0),
  CONSTRAINT chk_conv_grams CHECK (grams_used = grams_packed + grams_lost),
  status      VARCHAR(10) NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('APPLIED','REVERSED')),
  note        VARCHAR(300),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reversed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reversed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_proc_conv_entry ON procurement_conversions (entry_id);

CREATE TABLE IF NOT EXISTS procurement_conversion_lines (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversion_id   UUID NOT NULL REFERENCES procurement_conversions(id) ON DELETE CASCADE,
  shop_id         UUID NOT NULL REFERENCES shops(id),
  product_id      UUID NOT NULL REFERENCES products(id),
  shop_product_id UUID NOT NULL REFERENCES shop_products(id),
  packs           INTEGER NOT NULL CHECK (packs > 0),
  pack_size       INTEGER NOT NULL CHECK (pack_size > 0),
  unit_cost       NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
  movement_id     UUID REFERENCES stock_movements(id),
  reversal_movement_id UUID REFERENCES stock_movements(id)
);
CREATE INDEX IF NOT EXISTS idx_proc_conv_lines ON procurement_conversion_lines (conversion_id);
