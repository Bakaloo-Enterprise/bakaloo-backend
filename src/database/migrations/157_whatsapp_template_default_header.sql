-- 157: remember the picture used for a media-header template, so staff aren't asked for it on every send
ALTER TABLE wa_templates ADD COLUMN IF NOT EXISTS default_header_url TEXT;
