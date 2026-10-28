-- 172_media_assets.sql
-- Registry of every file we store ourselves (self-hosted media, replaces Cloudinary).
-- Lets us delete/replace images safely: a file is only trashed when nothing references it any more.

CREATE TABLE IF NOT EXISTS media_assets (
  public_id      TEXT PRIMARY KEY,                       -- e.g. grocery-app/products/ab12cd34ef56ab78cd90
  kind           VARCHAR(40)  NOT NULL DEFAULT 'general',-- products, banners, themes, whatsapp, avatars, rider-documents ...
  resource_type  VARCHAR(10)  NOT NULL DEFAULT 'image',  -- image | raw (Lottie)
  is_private     BOOLEAN      NOT NULL DEFAULT false,    -- KYC / proof photos: never in the public tree
  bytes          INTEGER,
  width          INTEGER,
  height         INTEGER,
  format         VARCHAR(10),
  sha256         CHAR(64),
  source         VARCHAR(12)  NOT NULL DEFAULT 'upload', -- upload | migrated
  uploaded_by    UUID,
  status         VARCHAR(10)  NOT NULL DEFAULT 'active', -- active | trashed | purged
  released_at    TIMESTAMPTZ,                            -- hint: an owner replaced/removed it, sweep it sooner
  trashed_at     TIMESTAMPTZ,
  purge_after    TIMESTAMPTZ,
  trash_dir      TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT media_assets_status_chk CHECK (status IN ('active', 'trashed', 'purged'))
);

CREATE INDEX IF NOT EXISTS idx_media_assets_status ON media_assets (status, created_at);
CREATE INDEX IF NOT EXISTS idx_media_assets_kind ON media_assets (kind) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_media_assets_purge ON media_assets (purge_after) WHERE status = 'trashed';
