-- 155: campaigns can choose the header picture per message (random banner, product photo, products on offer)
ALTER TABLE wa_campaigns ADD COLUMN IF NOT EXISTS header_image_source JSONB;
