# Media storage (self-hosted, replaces Cloudinary)

`MEDIA_PROVIDER=cloudinary` (default) = old behaviour. `MEDIA_PROVIDER=self` = files live on our disk and are served by nginx.
Flip back to `cloudinary` for an instant rollback (restart `bakaloo-api`).

## Env
`MEDIA_PROVIDER`, `MEDIA_STORAGE_DIR` (e.g. `/var/lib/bakaloo-media`), `MEDIA_PUBLIC_BASE_URL` (e.g. `https://media.bakaloo.in`), optional
`MEDIA_TRASH_DAYS=30`, `MEDIA_ORPHAN_GRACE_HOURS=24`, `MEDIA_RELEASE_GRACE_MINUTES=60`, `MEDIA_MAX_DIMENSION=2560`, `MEDIA_MIN_FREE_BYTES`.
Migration `172_media_assets.sql` creates the registry table.

## Disk layout (`MEDIA_STORAGE_DIR`)
- `served/master/<id>.webp`, `served/<profile>/<id>.webp` (cropped: icon 96, thumb 240, card 640, banner 1440x720, avatar 320; uncropped: detail 1280, capped1080, and **width buckets `w160 w320 w480 w640 w960 w1280`**: aspect ratio kept, never enlarged, the master is reused when the picture is narrower), `served/wa-jpeg/<id>.jpg`, `served/raw/<id>` (Lottie). nginx publishes only `served/`.
- `private/<id>.webp`: rider KYC and proof photos (any folder matching `riders/`, `documents/`, `proof`, `kyc`, `gst`). Not under `served/`. Reached by an unguessable id (same capability model Cloudinary had); signed URLs are a recommended follow-up.
- `trash/<date>/<id>/...`: replaced/deleted files, kept `MEDIA_TRASH_DAYS`, then purged.
- id = `grocery-app/<kind>/<20 hex>` (the same ids Cloudinary used, so old URLs map 1:1).

## Uploading
`POST /api/v1/uploads/image?kind=products|categories|banners|themes|branding|spin-scratch|nav-buttons|whatsapp|campaigns|avatars|shops|general`
(`/uploads/images` for several, `/uploads/file` for Lottie). Every upload: real-type check by magic bytes (JPEG/PNG/WebP only), pixel and size caps,
no animation, then **decoded and re-encoded** (EXIF and appended payloads are dropped; the upload itself is never stored), compressed, and all sizes written.
Compression: JPEG/WebP sources use the highest WebP quality (85 to 70) that is not larger than the upload; PNG/transparent use q90 with full alpha,
or lossless when barely bigger. Small "fill" crops never upscale. WhatsApp kinds also get a JPEG copy (Meta rejects WebP); other images get one on first use.

## Which size is served
The Flutter app asks for an uncropped image at a width (list 320, detail 520, home 132, x dpr 2) and crops "fill" spots itself with `BoxFit.cover`. Our own host is
resized client-side by `ApiConstants.optimizeOwnMediaUrl` (smallest bucket >= width x 2). The backend also chooses a bucket per screen so **old installed apps** get
small images too: product thumbnails `w640`, product gallery and banners `w1280`, category images `w320`, avatars `avatar`. In `cloudinary` mode these names are ignored (behaviour unchanged).

## Delete / replace
- `DELETE /uploads/image {publicId}` and `replaceMedia(old, new)` only **release** an image (mark it).
- A sweeper (worker, every 10 min; or `POST /uploads/cleanup?dryRun=true`) scans every text/json/array column for ids. A registered file that nothing references
  and that was released > 60 min ago, or is > 24 h old (an unsaved form's upload is safe), moves to `trash/`. A trashed file something points at again is restored.
- Safety: aborts if it would trash > 500 files or > half the candidates; images still used by any row are never touched; `media_url_rewrite_log` is ignored.
- Replace works because the admin saves the new URL (old one stops being referenced) and the old file is trashed after the grace period.

## Migrating existing images
Use `media-migration/` (backup, WebP, `sync`, `rewrite` with undo log, `register`, `check-links`). Legacy `res.cloudinary.com` URLs still stored anywhere are mapped
to the same file by `normalizeMediaDeliveryUrl`. nginx example: `media-migration/deploy/nginx-media.conf.example`.

## Tests
`npx vitest run tests/unit/media` (DB lifecycle tests are opt-in: `DB_NAME=<throwaway> MEDIA_DB_TEST=1`).
