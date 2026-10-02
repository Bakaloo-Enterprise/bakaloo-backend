# Bakaloo — WhatsApp CRM + Fulfillment POS + Procurement + Analytics
## Merged build plan (PDF v2.0 + V1 text + what already exists in the code)

Status: **Phases 1–12 built and tested locally — the whole agreement is now built. Nothing deployed, nothing committed.**
Date: 2026-10-02 · See section 9 for progress and decisions.

---

## 1. Source documents and how they are merged

| Source | What it gives us |
|---|---|
| `Bakaloo_Full_Functional_Agreement_v2.0.pdf` (23 pages, 1 Oct 2026) | Business scope. Superset: adds wholesale prospect outreach, multi-store conversation hub, procurement + distribution, bulk Excel catalog, business analytics |
| Pasted "V1 Functional & Architecture Agreement" | Technical grounding: reuse of existing tables, print-queue design, Socket.IO/BullMQ rule, dashboard menu tree, roles |

**Rule used when they differ: PDF v2.0 wins on scope, V1 wins on "reuse existing code".**

### Conflicts found and how they are resolved

| Topic | V1 says | PDF v2.0 says | Decision |
|---|---|---|---|
| Internal chat | Simple team chat (DM, group, @mention, share order/customer) | Multi-store hub (store↔store, HQ channels, order/product/procurement-linked threads, role visibility) | **One chat module.** Build DM/group/@mention first, same tables extended later with channels + linked references |
| Pipeline stages | Lead → Conversation → Registered → 1st → 2nd → 3rd → Repeat → Success | Same idea, plus manual stages: Needs Follow-up, B2B Opportunity, Negotiation | Stages are **configurable rows**. Seed V1's list; add PDF's manual-only stages. Auto-moves only touch the order-based stages |
| Abandoned-cart delay | Example: wait 15 min if cart > ₹500 | Default **5 min**, configurable | Default 5 min, configurable per rule. 15 min/₹500 is just an example workflow |
| Prospect outreach | not in V1 | CSV/Excel → validate → WhatsApp or SMS | Included (Phase 8) |
| Procurement / bulk catalog / business analytics | not in V1 | Full workspaces C and D | Included as later phases (10–12) |
| Store roles | Store Admin/Manager/Picker/Packer/Viewer | Same | Existing `shop_staff.role` CHECK only allows `SHOP_ADMIN/MANAGER/STAFF/VIEWER` → needs a migration for Picker + Packer |
| AI | "No complicated AI builder" | "No AI replies" | **No AI anywhere.** Bot is keyword/menu rules only |

### Explicitly out of scope (both documents agree)
Walk-in billing POS, payroll/attendance, full ERP/accounting, full Meta Ads Manager sync, AI replies, separate WhatsApp customer DB, separate fulfillment order DB, duplicate inventory, app-install tracking tokens, **silent bulk messaging without consent controls**.

---

## 2. What already exists (verified in the repo — reuse, do not rebuild)

| Need | Existing piece | Note |
|---|---|---|
| Customers + phone key | `users.phone` (UNIQUE, stored as normalised **10-digit**) ; `middlewares/validatePhone.js` | WhatsApp sends `91XXXXXXXXXX` (no `+`). Must normalise to the same 10-digit form before matching |
| Abandoned carts | Migration `082`: `abandoned_carts`, `_items`, `_events`, `_notifications`, `_coupons`; `workers/abandoned-cart.worker.js` | Detection runs in-process, 15 s poll. `ABANDONMENT_THRESHOLD_MS` is **1 min fixed**, though migration 082's comment says 10 min — stale comment, code is the truth. Current reminders go through app push; WhatsApp needs a new link table beside `abandoned_cart_notifications` |
| Audience building | `customer-segments`, `area-segments`, `business-accounts` (B2B) modules | Reuse as campaign audiences |
| Coupons | `coupons` module | Cart-rescue message can attach an allowed coupon |
| Scheduled sends | `workers/campaign-scheduler.worker.js`, BullMQ + Redis, `workers/processors.js` | Same pattern for WhatsApp campaigns/workflow waits |
| Realtime | `plugins/socketio.plugin.js` (rooms `user:`, `shop:`, `hq:global`…), dashboard `SocketProvider` + `socket-event-bridge` | Add `crm:*` rooms |
| Webhook raw body | `fastify-raw-body` already registered (`config: { rawBody: true }` per route) | Needed for Meta signature check |
| Permissions | `utils/permissions.js` (canonical string vocabulary) + `requirePermission()` + boot-time route audit | Every new route must declare a permission → add `crm.*` strings first |
| Staff | `shop_staff` (migration 030), `admin/team`, HQ roles | CRM Agent / CRM Manager roles needed |
| Rider, QR, allocation | migrations `096` pickup tokens, `098` qr_scan_logs, `rider-assignment`, `allocation` modules | POS reuses these |
| Audit | `audit-logs`, `admin/activity-log` | CRM actions write here |
| Dashboard UI | Next 14, `@dnd-kit`, `socket.io-client`, TanStack Query, zustand, recharts, Radix/shadcn; `Sidebar.tsx` + `PermissionGate.tsx` | No new UI framework needed |
| Excel/CSV | backend `exceljs`, `csv-parse` | Import for prospects + bulk catalog |
| SMS | `twilio` dep + 2Factor.in (`SMS_PROVIDER`) | **2Factor is wired for OTP only.** Promotional SMS in India needs DLT-registered sender/templates → provider decision needed |

**Not found in code:** any existing team-chat, so "expand the existing internal chat" is really a new build.

---

## 3. GitHub research (done with Firecrawl) and trust verdicts

**Nothing has been cloned or installed. You decide in section 9.**

| Repo | Real numbers (checked today) | Verdict |
|---|---|---|
| `ArnasDon/wacrm` — WhatsApp CRM template | MIT, TS, 2,473★, **6,370 forks**, 766 commits, active (pushed 28 Sep), Next.js 16 + Supabase | ⚠️ **Cloned read-only to a scratch folder (outside the project) with your approval, scanned, and used as a pattern reference only.** Scan found no install hooks, no eval/child_process, no telemetry SDKs, no hardcoded secrets; outbound hosts are Meta + OpenAI/Anthropic (its AI feature, which we exclude). The fork/star ratio is still unexplained. Nothing was installed or run from it. Forks ≈ 2.6× stars is unusual and I can't explain it. Wrong stack (Supabase, not Fastify/Postgres). Includes an AI-reply feature we must not use. Useful to *read* for webhook/status handling ideas. **Do not clone into the project or run it** |
| `chatwoot/chatwoot` | 37k★, very active, Ruby/Vue, license `NOASSERTION` (mixed) | Trusted project, but wrong stack + heavy. Inspiration for inbox UX only |
| `WhatsApp/WhatsApp-Nodejs-SDK` (Meta's own) | **Archived** since 2023 | ❌ Don't depend on it |
| `great-detail/WhatsApp-JS-SDK` | MIT, 40★, active, 7 forks | Small community. Optional |
| `MarcosNicolau/whatsapp-business-sdk` | MIT, 167★, last push Feb 2026 | Optional, slower maintenance |
| `fbsamples/whatsapp-api-examples` (Meta) | 293★, official samples, updated Jul 2026 | ✅ Trusted **reference** for webhook signature validation + template examples |
| `xyflow/xyflow` (React Flow) | MIT, 38k★, very active | ✅ Only if we later want a *visual* workflow builder. V1 says keep rules simple → **not needed now** |
| `catamphetamine/libphonenumber-js` | MIT, 3k★, active | ✅ Recommended for phone validation in CSV import |

**Recommendation:** write a thin WhatsApp Cloud API client ourselves with `axios` (already installed). The API is plain REST (send message, templates, media, webhooks). That avoids an archived or low-star SDK in the core path. Add `libphonenumber-js` for imports. Use Meta's official docs + `fbsamples` as the reference.

---

## 4. WhatsApp rules the design must respect (these shape the code)

1. **24-hour window:** free-form replies are only allowed within 24 h of the customer's last inbound message. Outside it, only an **approved template** can be sent. The inbox composer must enforce this, not just warn.
2. **Templates:** statuses Draft → Pending → Approved/Rejected. Pending/Rejected templates are blocked from campaigns and workflows (PDF §05).
3. **Webhook security:** verify `X-Hub-Signature-256` (HMAC-SHA256 of the **raw body** with the app secret) before touching the payload; handle the GET verify-token handshake.
4. **Idempotency:** Meta retries webhooks. Dedupe on WhatsApp message id (`wamid`) with a unique index.
5. **Fast ack:** webhook returns 200 quickly and pushes processing to BullMQ.
6. **Consent / opt-out:** only message permitted contacts; a suppression list is checked on every bulk send. STOP-style replies add to it.
7. **Pricing is per-message by category** (marketing/utility/authentication/service) and changes over time → store versioned rate cards, never hard-code (agreement §13).
8. **Secrets** (access token, app secret, verify token) go in `.env`/encrypted settings, never in Git or the dashboard bundle.
9. **Internal vs customer messages** live in different tables and different UI components, so an internal note can never be sent to a customer by mistake.

---

## 5. Data model (new migrations, numbered after `140`)

CRM core: `wa_accounts` (WABA/phone-number config), `wa_contacts` (phone, `user_id` nullable, source, referral/ad JSON, opt-in state), `wa_conversations` (contact, owner, status, `last_inbound_at`, unread, stage_id), `wa_messages` (direction, type, body/media, `wamid` UNIQUE, status, error code/reason, template_id, campaign_id), `wa_labels` + `wa_contact_labels`, `crm_stages` + `crm_stage_history`, `crm_notes`, `crm_followups`.
Bot/automation: `wa_bot_rules` (keyword/menu → reply, priority, hours), `wa_workflows` (+ `wa_workflow_runs`).
Templates/campaigns: `wa_templates` (meta_template_id, status, category, language, reject_reason, last_synced_at, components JSON), `wa_campaigns`, `wa_campaign_recipients` (per-message status), `wa_suppression`, `wa_prospect_imports` + rows.
Cost: `wa_rate_cards` (versioned, effective-from), `wa_usage_events`.
Cart link: `abandoned_cart_wa_messages` (links episode → `wa_messages`).
Internal chat: `chat_channels`, `chat_members`, `chat_messages` (+ `ref_type/ref_id` for order/product/procurement/customer).
Roles: extend `shop_staff.role`; add `crm.*` permissions.
Later phases: print jobs, picker/packer tasks, procurement entries/allocations/adjustments, bulk-import batches, analytics rollups.

Auto-stage rule: orders reference `users`; stage moves are driven by order events (first/second/third delivered-or-placed order — **confirm which trigger, §9**), written to `crm_stage_history` with actor = SYSTEM so manual drags are never silently overwritten.

---

## 6. Phases (CRM first, as you asked)

| # | Phase | Delivers | Maps to |
|---|---|---|---|
| 0 | Setup + decisions | Meta account/number ready, env vars, permissions vocabulary, sidebar entry "WhatsApp CRM" | — |
| 1 | Foundation | Migrations, Cloud API client, signed webhook, BullMQ inbound processor, send-message, status updates, phone→customer matching | V1 §3,§9 · PDF §01-03 |
| 2 | Inbox + Customer 360 | 3-pane inbox, search/unread/source, realtime, 24 h-window composer, Customer 360 panel + timeline | V1 §4,§8 · PDF §03 |
| 3 | Labels, ownership, workload | Labels, assign/transfer/bulk reassign, agent workload view | V1 §5,§16 · PDF §03,§09 |
| 4 | Pipeline | dnd-kit Kanban, cards, auto stage moves from orders, priority + next action | V1 §6,§7 · PDF §04 |
| 5 | Rule-based bot | Greeting/hours/area/order-help rules, human handoff, no AI | PDF §03.5 |
| 6 | Templates + Meta approval | Library, create/submit/sync, status + reject reason, usage gating | V1 §10,§11 · PDF §05 |
| 7 | Campaigns, workflows, abandoned-cart WhatsApp | Audiences from segments, schedule, WHEN/IF/DO builder, 5-min cart reminder + optional coupon, one-click cart rescue, order-event messages (packed/out for delivery/delivered) | V1 §12,§14,§15,§40 · PDF §06 |
| 8 | Wholesale prospect outreach | CSV/Excel upload → validate/dedupe → existing-vs-new match → WhatsApp/SMS send with consent + suppression | PDF §07 |
| 9 | Internal chat | DM/group/@mention/unread, then store/HQ channels + order/product-linked threads | V1 §17 · PDF §08 |
| 10 | CRM analytics + cost | Sent/delivered/read/replies/orders/revenue, versioned cost, per campaign/template | V1 §13 · PDF §09 |
| 11 | Fulfillment POS | Live board, picker/packer, scan, OOS, print queue + retry, rider assign, QR handover, Needs-Attention, performance, audit | V1 Part B · PDF §10-14 |
| 12 | Procurement, bulk catalog, business analytics | Procurement entry/split/reservation/adjustments, Excel bulk update with preview, financial dashboard + reconciliation | PDF §15-19 |

Each phase ends with: migrations applied **locally only**, unit/integration tests (vitest exists in both repos), UI check in the browser, and a short demo note. Production deploys/migrations only when you explicitly ask (per backend `CLAUDE.md`).

---

## 7. Where things will live

- Backend: `src/modules/whatsapp-crm/` (client, webhook, conversations, contacts, templates, campaigns, bot, workflows, chat) registered under `/api/v1/admin/crm/*`; webhook at `/api/v1/webhooks/whatsapp` (public, signature-verified); workers added to `src/workers/`.
- Dashboard: `src/app/(dashboard)/whatsapp-crm/{inbox,pipeline,customers,templates,workflows,campaigns,team,chat,analytics,settings}` + `src/components/whatsapp-crm/*`; menu group in `Sidebar.tsx`, gated by `PermissionGate`.

## 8. Testing approach
Webhook signature + idempotency tests, phone-matching tests (`+91`, `91`, 10-digit), 24 h-window enforcement, template-status gating, stage-automation tests (property tests with `fast-check`, already installed), and a local mock of Meta's webhook so we can test **without sending real WhatsApp messages**.

## 9. Decisions made and progress

### Decisions (from you)
- **Meta Cloud API directly** (no BSP). Meta credentials are not set up yet → everything is built against a signed local mock.
- **WhatsApp only.** No SMS work. 2Factor stays OTP-only. Phase 8 (prospect outreach) is WhatsApp-only.
- **Pipeline auto-moves when an order is PLACED** (cancelled orders will need a rollback rule — Phase 4).
- **Phase 1–2 admin-only**; `crm.*` permissions added deliberately in Phase 3 (touches the tested 37-string vocabulary + migration 046).
- **Cloning approved** for both repos; used as references, code re-written for this stack.
- Local test DB: isolated throwaway Docker containers `bakaloo_crm_pg` (port 55432) and `bakaloo_crm_redis` (56379) — ports 5432/6379 are used by other projects' containers, which were not touched.

### Findings that changed the design (all verified against Meta's own docs)
1. **Phone is not always available.** With WhatsApp usernames, Meta omits the phone from webhooks (unless interacted in the last 30 days / contact book). A business-scoped user ID (BSUID, `user_id`) is always sent. → `wa_contacts` is keyed by `wa_id` OR `bsuid`; username-only customers appear as *unmatched* until their phone is known; sends use `recipient` (BSUID) instead of `to`.
2. **Graph API version:** wacrm pins v21.0 which **expires 2027-01-21**. We default to **v25.0** (supported to 2028-07-29; v26.0 is newest), configurable via `WHATSAPP_API_VERSION`.
3. **App-wide AJV `removeAdditional:'all'`** strips every undeclared field even with `additionalProperties:true`; the webhook parses the signed raw bytes itself.
4. **Meta error codes that need business logic:** 131047 (24 h window), 131050 (customer opted out of marketing → we set `OPTED_OUT`), 131049 (per-user marketing cap), 131026 (not on WhatsApp), temporary/throttle codes for retry (1, 2, 4, 80007, 130429, 131000, 131016, 131056, 131057, 133004).
5. **Template statuses** also include PAUSED, DISABLED, IN_APPEAL, PENDING_DELETION (the PDF lists only 4). Account limit: 250 templates.
6. Exact 10-digit phone match only (wacrm's last-8-digits match could merge two different customers).

### Phase status
| # | Phase | Status |
|---|---|---|
| 0 | Setup | ✅ env vars, local DB, plan |
| 1 | Foundation | ✅ **done + tested locally** (details below) |
| 2 | Inbox + Customer 360 (dashboard UI) | ✅ done (customer 360 panel is basic; orders/cart/timeline come with Phase 4+) |
| 3 | Labels, ownership, workload, CRM roles | ✅ **done + tested** (below) |
| 4 | Customer pipeline (Kanban) | ✅ **done + tested** (below) |
| 5 | Rule-based bot + human handoff | ✅ **done + tested** (below) |
| 6 | Templates + Meta approval tracking | ✅ **done + tested** (below) |
| 7 | Campaigns, workflows, abandoned-cart WhatsApp | ✅ **done + tested** (below) |
| 8 | Wholesale prospect outreach | ✅ **done + tested** (below) |
| 9 | Internal team chat | ✅ **done + tested** (below) |
| 10 | CRM analytics + cost | ✅ **done + tested** (below) |
| 11 | Fulfillment POS | ✅ **done + tested** (below) |
| 12 | Procurement, bulk catalog, business analytics | ✅ **done + tested** (below) |

### Phase 1 — what exists
- Migration `141_whatsapp_crm_foundation.sql` (`wa_webhook_events`, `wa_contacts`, `wa_conversations`, `wa_messages`). Re-runnable. `users` untouched.
- `src/modules/whatsapp-crm/`: `meta-client.js`, `webhook-signature.js`, `webhook-parser.js`, `phone.js`, `status-ladder.js`, `whatsapp.repository.js`, `inbound.service.js`, `send.service.js`, `webhook.routes.js`, `whatsapp.factory.js`, `errors.js`.
- Public webhook `GET/POST /api/webhook/whatsapp` (HMAC-verified, fail-closed, stores raw event, queues, acks fast).
- BullMQ queue `whatsapp-inbound` + worker + 1-minute sweep for lost jobs.
- Admin API `/api/v1/admin/crm/*`: `status`, `conversations`, `conversations/:id`, `…/messages` (GET, POST), `…/read`.
- Realtime events `crm:message`, `crm:status` → rooms `admin:dashboard` + `hq:global`.
- 73 new tests (57 unit + 16 on a real Postgres) + an end-to-end smoke run of the live API and worker. All pass. Existing suite: same pre-existing ~20 failures as untouched HEAD, **0 new**.

### Known limits / to do before production
- Realtime goes to all admins until per-agent rooms (Phase 3).
- Inbound media is stored as a Meta media id only; downloading/mirroring comes with the inbox UI.
- Reactions are ignored for now. Template status webhooks are logged only (Phase 6).
- Template sends are not exposed yet (Phase 6 gates them on APPROVED status).
- Unmatched BSUID-only contacts need a manual "link to customer" action (Phase 2).
- Deploy to production only on your explicit request: add the 6 env vars, run `npm run db:migrate`, `pm2 reload bakaloo-api`, `pm2 restart bakaloo-worker`, then register the webhook URL in Meta.

### Phase 3 — what exists
- Migration `142`: `wa_labels` (11 starter labels from the agreement), `wa_contact_labels`, `wa_assignment_log` (who/from/to/when), roles **CRM Agent** and **CRM Manager**. Canonical 37-string RBAC untouched.
- Permissions (free-form strings in `roles.permissions`; HQ SUPER_ADMIN/ADMIN always pass): `crm.inbox.view`, `crm.inbox.view_all`, `crm.inbox.reply`, `crm.labels.apply`, `crm.labels.manage`, `crm.conversations.assign`, `crm.workload.view`.
  - **Agent** = view (own + unassigned), reply, apply labels, claim an unassigned chat. **Manager** = everything.
- Rules: agents never see/probe other agents' chats (404, same as missing); only managers assign/transfer/unassign/bulk-move (max 200); assignees must be eligible agents; same-owner moves change and log nothing.
- Realtime events are now content-free (ids only) so agents can't receive other agents' message text over the socket.
- API additions: `/me`, `/agents`, `/workload`, `conversations/:id/assign|assignments|labels`, `conversations/bulk-assign`, `/labels` CRUD.
- Dashboard: owner + label filters, bulk select/move, owner control in chat header ("Take this chat" for agents), label chips/picker in customer panel, Workload page, Labels page.
- Tests: +21 real-DB, 32-check HTTP role matrix, +6 component tests. 0 new failures in either repo.

### Decisions still open for Phase 3
- No auto-assignment of new conversations (round-robin) yet — all start unassigned. Say if you want it.
- Sidebar shows Workload/Labels to everyone; those pages show "not authorized" without the permission.

### Phase 4 — what exists
- Migration `143`: `crm_stages` (11 configurable rows: 7 automatic + 4 human-only), `wa_contacts.stage_id/stage_source/stage_changed_at`, `crm_stage_history`, index on `orders(user_id,status)`; permissions `crm.pipeline.view` / `crm.pipeline.move` added to CRM Agent, CRM Manager and the legacy Super Admin role.
- **Automatic stage rules** (`pipeline.js`, unit-tested): Lead → Conversation (first agent reply) → Customer (phone registered in Bakaloo; auto-linked) → 1st / 2nd / 3rd Order → Repeat (4+).
  - "Order placed" = status not in PENDING / CANCELLED / REFUNDED (an unpaid PENDING order can still expire).
  - **Rollback rule:** cancelling an order moves an AUTO card back.
  - Automation **never** moves a card out of a human-only stage (Success, Needs Follow-up, B2B Opportunity, Negotiation), and a card an agent placed on the ladder only moves forward.
  - Done by a once-a-minute BullMQ reconcile job + an immediate check on new contacts / first reply. **No trigger on `orders` or `users`.**
- Board API `GET /pipeline` (filters: owner, label, B2B/B2C, search; agents only see own + unassigned; capped at 500 cards), `POST /pipeline/contacts/:id/stage`, `GET …/history`.
- Card = name, source, labels, orders, spend, open abandoned-cart value, waiting time, owner, **priority** (HIGH/MEDIUM/NORMAL) and **next action** (Reply now / Call back / Send coupon / Assign to B2B).
- Dashboard: `/whatsapp-crm/pipeline` — dnd-kit board with mouse + keyboard drag, optimistic move with rollback, filters, realtime refresh, card click opens the chat.
- Tests: +20 real-DB, +25 rules, +19-check HTTP matrix, +10 component/hook. 0 new failures in either repo.

### Known limits (Phase 4)
- "Area" filter from the agreement is not built (no reliable area on the contact yet); owner / label / B2B / search are.
- Stage editing (rename/reorder/add) has no UI yet — stages are DB rows, ready for it.
- Reconcile scans all WhatsApp contacts each minute (fine to tens of thousands; switch to a changed-since watermark if it grows).
- The mouse drag itself was verified via keyboard drag in a real browser plus component tests; the pane was hidden so a pointer drag was not exercised.

### Phase 5 — what exists
- Migration `144`: `wa_bot_settings` (**master switch defaults OFF**), `wa_bot_rules` (12 English starter rules, editable), `wa_bot_events` (every decision logged), `wa_conversations.bot_state/bot_paused_until/bot_handoff_reason`, `wa_messages.is_bot/bot_rule_id`; permission `crm.bot.manage` (CRM Manager + legacy Super Admin).
- **No AI.** Rules: match type (contains / exact / starts with / PIN code), keywords + `exact_keywords` (menu digits only fire when they are the WHOLE message — "2 kg onions" never triggers "2"), store-open/closed condition, action (reply · reply+handoff · handoff · opt-out · opt-in), cooldown. First match by position wins. Works for any script (Hindi/Bengali keywords tested); each rule has ONE reply text.
- Variables: `{{customer_name}}`, `{{last_order}}` (real latest-order status), `{{business_hours}}` (from the store schedule, IST), `{{pincode_result}}`. Business hours come from the same `StoreStatusService.isOpen()` the storefront uses.
- **Delivery area:** says "we deliver there" only when an active shop LISTS the PIN; otherwise it never says "no" (radius coverage can't be proven from a PIN) — it hands to a person.
- **Fail-safe handoff** to a person (bot goes quiet for `human_pause_minutes`, default 12 h) on: no rule matched, photo/voice/document, rate limit, failed send, handoff rules, or any internal error. An agent reply also pauses the bot. It resumes after the quiet period or when a resolved chat reopens. Stickers are ignored.
- Safety rails: master switch OFF by default; stale messages (>10 min) never answered; max replies per chat per hour (default 6); bot messages are flagged and **do not count as an agent reply** for the pipeline; a chat the bot fully handled is shown answered+read, a handed-off one keeps waiting for a person; STOP/START record marketing consent.
- Admin API `/bot/settings|rules|rules/reorder|test|activity`, `POST /conversations/:id/bot` (Take over / Resume bot). Rule validation rejects digit-only/1-character keywords in "contains" rules.
- Dashboard: **Auto-reply Bot** page (on/off switch, settings, rule editor with ordering, "Try a message" dry-run, recent activity); inbox shows "Bot active / With team / Needs a person", Take over / Resume bot, and an "Auto-reply (bot)" tag on automatic messages.
- Optional env `WHATSAPP_API_BASE_URL` (mock/proxy; leave unset in production). Client verified against a real local HTTP listener.
- Tests: +37 real-DB bot tests, +34 rule-logic tests, +33-check HTTP matrix, +17 UI tests, +1 client HTTP test; live run with a mock Graph server (bot OFF → nothing sent; ON → replies, handoff, silence while with a person).

### Known limits / open items (Phase 5)
- Replies are text only (no WhatsApp interactive buttons/lists yet); one language per rule.
- Bot messages are not in analytics yet (Phase 10 will use `is_bot` and `wa_bot_events`).
- "Order status" answers from the customer's latest order only; matching a specific order number the customer types is not built.
- One flaky pre-existing property test (`allocation-computation`) fails randomly on untouched HEAD too — unrelated.

### Phase 6 — what exists
- Migration `145`: `wa_templates` (status, Meta id, rejection reason, quality, pending re-categorisation, flagged/locked, ordering timestamps), `wa_template_events` (history), `wa_messages.template_id`; permissions `crm.templates.view` / `.send` (agents + managers) and `.manage` (managers).
- **Researched against Meta's current docs (2026-10-01)** — limits baked in as validation: name `^[a-z0-9_]+$`; header ≤60 chars/≤1 variable/no markdown; body ≤1024; footer ≤60; ≤10 buttons (quick reply ≤10, link ≤2 with ONE variable at the end, call ≤1), label ≤25; quick replies grouped; variables must not start/end the message or touch each other; every variable needs an example; named parameters (`{{customer_name}}`) for new templates. 100 creations/hour and 250-template (6,000 verified) caps surface as clear errors.
- Library: draft → **submit to Meta** (atomic claim: double-click can't submit twice; Meta failure returns it to draft) → status via **webhooks** (approved, rejected + reason + Meta's fix recommendation, paused, disabled, in appeal, flagged, locked, reinstated, archived, deleted, quality score, **category change incl. the 24 h advance notice**) plus **Sync with Meta** (manual + every 6 h) that also imports templates made in WhatsApp Manager.
- Safeguards: stale/out-of-order webhooks never overwrite newer state; sync is single-flight (advisory lock), never wipes the library on an empty/odd answer, never touches drafts; webhook language `en-US` matched to API `en_US`; the `template_category_update` webhook (different name prefix) is routed (Phase 1's parser would have dropped it).
- Edit rules per Meta: only approved/rejected/paused editable; approved keeps name/language/category; edit replaces all components and re-enters review. Numbered-variable (`{{1}}`) and media-header templates from WhatsApp Manager are view/send-only here.
- **Sending from the inbox** (closes the 24-hour-window gap): "Template" button → pick an APPROVED template → customer details pre-filled (name, latest order, open cart) → preview → send. One gate (`canSend`) for every path: only APPROVED; marketing blocked for opted-out customers; every variable must have a value; Meta errors 132001/132015/132016/131050/131049/131026 mapped to advice and our records kept honest. A person sending pauses the bot.
- Dashboard: **Templates** page (status tabs with counts, filters, status chips with reason/quality/at-risk/category warnings, create/edit with live phone-style preview and per-field server errors, history timeline), "Not connected" banner, realtime refresh on approval.
- Tests: +73 rule tests, +6 client (real HTTP listener), +64 real-DB (lifecycle, sync, webhooks, send gates), +26 UI, +28-check HTTP matrix. Three deliberate code breakages (send gate, stale-webhook guard, consent check) were each caught by the tests, then restored.

### Known limits / open items (Phase 6)
- **Image/video/document header templates can't be CREATED here** (Meta requires its Resumable Upload API; planned follow-up). Synced ones can be viewed and sent (staff paste an https link).
- Authentication (OTP) templates and location headers: listed but not creatable/sendable.
- Language picker offers en, en_US, en_GB, hi, bn (Meta's full list not yet browsed).
- Marketing consent: inbox sends are blocked only for customers who explicitly OPTED_OUT; campaigns (Phase 7/8) will require opt-in.
- Variable auto-fill covers customer_name, order_number, order_status, cart_value; anything else is typed by staff.

### Phase 7 — what exists
- Migration `146_whatsapp_crm_campaigns_workflows.sql`: `wa_campaigns`, `wa_campaign_recipients` (unique per campaign + contact), `wa_suppression`, `wa_workflows`, `wa_workflow_runs` (unique per workflow + event), `abandoned_cart_wa_messages`, `wa_contacts.consent_source`, `wa_messages.campaign_id/workflow_id`; permissions `crm.campaigns.view`, `crm.campaigns.manage`, `crm.workflows.manage` (CRM Manager + Super Admin only; agents get none).
- **Consent rule (one function, `consentDecision`)**: campaigns reach only `OPTED_IN` contacts. Never `OPTED_OUT`, never the do-not-contact list. Automatic *utility* messages (order updates) may also reach an unknown-consent customer who has messaged us first; *marketing* never does. Re-checked on every single send, not only at launch.
- **Campaigns**: draft → "Check who will receive it" (counts + skip reasons) → send now or schedule (1 min – 30 days ahead). Audience = customer segments, WhatsApp labels, pipeline stages, or everyone opted in; snapshotted at launch. Paced by messages/minute (10-second tick), parallel-safe (`FOR UPDATE SKIP LOCKED`). Pause / resume / cancel. Results read from the real message status (sent / delivered / read / failed / skipped, with reasons) — nothing is copied, so webhook updates stay the single truth.
- **Self-protection**: a template Meta pauses/disables or stops approving pauses the campaign (recipient put back, not failed); 131050 opt-out → skipped + `OPTED_OUT` recorded; 131049 / 131026 / blocked → skipped; temporary Meta errors retried 3×; a worker that dies mid-send never causes a duplicate (a recipient with a created message is marked "unknown outcome", not re-sent).
- **Quiet hours**: marketing templates are not sent 9 pm – 9 am IST (campaigns wait for 9 am; cart reminders in that window are skipped).
- **Workflows (WHEN / IF / DO)**: triggers *cart abandoned for N minutes* (default 5, 1 min – 24 h) and *order becomes CONFIRMED / PACKED / OUT_FOR_DELIVERY / DELIVERED / CANCELLED*. Conditions (cart value, items, past orders, order total, payment method). Actions: send an approved template (with optional **public** coupon on cart reminders) and add a label. No hooks into the orders/cart code: a 30-second BullMQ scan claims events by inserting a run row, so each event fires **once** however many workers run. Events before switch-on are never back-filled; cart reminders older than 2 h past due and order messages older than 30 min are dropped; a coupon that stopped working means no message at all.
- **Cart link**: tokens `{{cart_link}}` and `{{cart_ref}}` need the new optional env `CUSTOMER_APP_URL`; a workflow using them cannot be switched on without it. Each cart reminder is linked in `abandoned_cart_wa_messages` (+ `abandoned_cart_coupons`) and bumps the cart's reminder count.
- Automated messages are tagged, appear in the chat, and **do not** pause the bot, count as a person replying (pipeline stage), or make a waiting chat look answered.
- Consent tools: "Record opt-ins" (paste 10-digit numbers + where they agreed + explicit confirmation; never overrides an opt-out) and a do-not-contact list (managed on the Campaigns page, and a button in the inbox customer panel).
- Dashboard: **Campaigns** page (list with live progress, builder dialog, detail sheet with launch checklist / controls / per-person results, consent panel) and **Workflows** page (plain-language WHEN/IF/DO cards, on/off switch, recent-activity log, builder dialog).
- Admin API (all under `/api/v1/admin/crm`): `campaigns` (+ `/options`, `/:id/preview|launch|pause|resume|cancel|recipients`), `consent/record`, `suppression`, `workflows` (+ `/catalog`, `/:id/activate`).
- Tests: +23 rule tests, +39 real-DB (consent, pacing, quiet hours, retries, template pause, crash recovery, concurrency, cart + order workflows), +17 UI; 38-check HTTP matrix; live run with a real worker + mock Graph API (campaign and order message sent once, within the scan interval). Two deliberate breakages (consent gate, once-only claim) were caught by the tests, then restored. 0 new failures in either repo.

### Known limits / open items (Phase 7)
- **Nothing creates opt-ins by itself yet** except a customer replying START and staff recording them. A checkout "send me WhatsApp updates" checkbox in the customer app would feed this properly — needs a decision (app change).
- Campaign values are the same for everyone (plus the customer's name); per-customer variables (e.g. their last order) are only available in workflows.
- No A/B testing, no recurring campaigns, no per-campaign cost (Phase 10 adds cost + conversion attribution).
- Cart reminders attach a coupon only if it is open to all customers; per-customer generated coupons are not built.
- Workflows send one template per event; multi-step sequences (wait, then a second message) are not built.
- Order "CANCELLED" messages and "wait for payment" cases are not special-cased.
- Several DB test suites share one database: run them with `--no-file-parallelism` (Phase 6's template-sync test marks other suites' templates as missing when run in parallel).


### Phase 8 — what exists
- Migration `147_whatsapp_crm_prospect_imports.sql`: `wa_prospect_imports` (PREVIEW → CONFIRMED, consent source, who/when) and `wa_prospect_rows` (per-row result, linked contact, `selected`). No new permissions: reuses `crm.campaigns.view` / `.manage`.
- **Flow: upload → preview → confirm → send via a normal campaign.** An upload creates only preview rows — no contacts, no consent, no message. Confirming records the uploader's consent statement and makes the usable rows reachable; sending is a separate campaign with the new audience type **Prospect list** (`IMPORT`), so every Phase 7 safeguard still applies (approved template, opt-out, do-not-contact list, quiet hours, pacing, consent re-checked on each send).
- File: `.csv` or `.xlsx` (first sheet), up to 5,000 rows / 5 MB. Columns found by name (Phone/Mobile/WhatsApp…, Name/Contact person…, Business/Company/Shop…); a number typed as a number in Excel is read correctly. Numbers are normalised to the same `91XXXXXXXXXX` form as everything else.
- **Row results:** New · Already in WhatsApp CRM · Existing Bakaloo customer (left out unless "include existing" is ticked) · Invalid number · Repeated in the file · Opted out · Do-not-contact. Opted-out and do-not-contact rows can never be added; an opt-out that arrives between preview and confirm is never overridden (checked at confirm time too).
- Confirm needs an explicit "these people agreed" tick and a source (e.g. "trade show form"); both are stored on the contact (`consent_source = PROSPECT_…`) for audit. Double-confirm / concurrent confirm adds the list once. A preview that is never confirmed can be discarded (its personal data goes with it); a confirmed list cannot be deleted.
- Admin API (under `/api/v1/admin/crm`): `prospects/imports` (GET list, POST multipart upload), `prospects/imports/:id` (GET, DELETE), `…/rows` (filter by status), `…/confirm`; `campaigns/options` now also returns confirmed prospect lists with their reachable count.
- Dashboard: **Prospects** page (upload, per-row preview with status filter, "Also include existing customers", consent form, list of past imports) and a "Prospect lists" audience in the campaign builder. Sidebar entry under WhatsApp CRM.
- Tests: +10 rule tests (`prospect-import`), +12 real-DB (classification, no side-effects on preview, opt-out race, concurrent confirm, campaign hand-off, opted-out-after-confirm skipped), +6 UI, 29-check HTTP matrix (401/403 roles, multipart upload, validation, confirm, campaign audience); verified in a real browser (upload → preview → confirm → consent recorded in DB). One deliberate breakage (opt-out guard) was caught by the tests, then restored. Backend: same ~20 pre-existing failures as untouched HEAD, 0 new; dashboard: failures are in untouched legacy suites (RBAC, shops, login, orders).

### Known limits / open items (Phase 8)
- **WhatsApp only** (decision); no SMS fallback for numbers not on WhatsApp — those show as failed/skipped (Meta 131026) in the campaign results.
- The consent statement is an attestation by the uploader — we cannot verify it. The wording and source are stored; legal review of the collection method is the business's call.
- Prospect names are used for `{{customer_name}}` (name, else business name); other columns in the file are ignored. Per-prospect template values are not supported (same as all campaigns).
- No re-upload merge: uploading the same people again creates a new list; contacts are de-duplicated by number, so nobody is messaged twice within one campaign, but two campaigns can both reach them.
- Large files are processed in one request (5,000 rows is fast); a background import job is not needed at this size.

### Phase 9 — what exists
- Migration `148_team_chat.sql`: `chat_channels` (DM / GROUP / CHANNEL, optional stored audience), `chat_members` (OWNER/MEMBER, `last_read_seq`), `chat_messages` (per-channel monotonic `seq`, mentions, one optional shared item, soft delete). **Separate from `wa_*` tables on purpose** — an internal message can never be sent to a customer and no customer message is stored here (tested: chat writes nothing to `wa_messages`/`wa_conversations`).
- **Who can chat:** every active dashboard user (role ADMIN: HQ and store staff) — customers and deactivated staff are refused, checked on every request. `chat.manage` (HQ SUPER_ADMIN/ADMIN, or any role listing it) is needed to create channels and to moderate (delete others' messages).
- **Kinds:** *DM* (one per pair, whoever starts it; cannot be renamed/extended/left), *Group* (anyone can start; creator is owner; owner adds/removes/renames/archives; members can leave; ownership passes on; last one out archives it), *Channel* (HQ managers only; members chosen by hand and/or by **audience** = all HQ staff and/or everyone at chosen stores → store ↔ store and HQ ↔ store channels; "Refresh people" adds new joiners and never removes anyone; members cannot walk out of a managed channel). Max 100 people per chat.
- **Privacy:** a chat you are not in does not exist for you — every call answers 404 (not 403), even for HQ managers. Removing someone or deactivating them cuts access immediately. Realtime goes only to the personal `user:{id}` rooms of the chat's members (never a broadcast room). People list exposes name, HQ/store only — no phone or email.
- **Messages:** up to 4,000 chars, send on Enter. **@mentions** (only members; never yourself; non-members silently dropped) raise a separate mention count. **Unread** per chat and total (sidebar badge), exact even under concurrent sends (inserts are serialised per channel); a message deleted before it is read stops counting; people added later do not see history as unread. Delete = soft: text, mentions and shared item are erased, a "Message deleted" marker stays. 30 messages/minute per person. Archived chats are read-only and restorable.
- **Linked threads (V1 "share order/customer", PDF "order/product-linked"):** a message can carry one **Order**, **Product** or **Customer**. Rules: store staff may share only their own store's orders; HQ any order; products by anyone; customers by HQ only and by **name only** (never the phone). Search for these is scoped the same way. Label is a snapshot; the link opens the normal page where each viewer's own access applies. Procurement links join in Phase 12.
- API (`/api/v1/admin/chat`): `me`, `people`, `unread`, `refs`, `channels` (GET/POST), `channels/:id` (GET/PATCH), `…/members` (POST, DELETE `/:userId`), `…/archive|unarchive|refresh-audience`, `…/messages` (GET with `before`/`limit`, POST), `…/messages/:messageId` (DELETE), `…/read`. Auth runs in `onRequest`, so an unauthenticated caller gets 401 before any validation.
- Realtime events: `chat:message`, `chat:message_deleted`, `chat:channel`, `chat:read`.
- Dashboard: **Team Chat** page (`/whatsapp-crm/chat`, sidebar item with unread badge): chat list (Active/Archived, unread, "@" for mentions), thread with day headings, @mention suggestions (keyboard + mouse), attach picker, delete, details dialog (members, rename, add/remove, leave, archive/restore, refresh), New chat dialog (DM / group / channel for managers). A background tab does not mark chats read; returning to it does. Mobile: list ↔ thread.
- Tests: +22 rule tests, +34 real-DB (access, DM/group/channel rules, privacy 404s, unread/mentions, ordering under concurrency, rate limit, sharing scope, separation from WhatsApp tables), +23 UI, 43-check HTTP matrix; verified live in a real browser with two users (realtime delivery, mention highlight, unread badge, mark-read on focus, composer with @ suggestions). One deliberate breakage (membership check) caught by 3 tests, then restored. The live run found a real bug the mocked UI test had hidden (shops hook returns `{items}`, not an array) — fixed and the test now uses the real shape. Backend: same ~20 pre-existing failures as untouched HEAD, 0 new; dashboard: same legacy failing files as before.

### Known limits / open items (Phase 9)
- Text only: no file/image attachments, no message editing, no emoji reactions, no typing/online indicators, no search inside chats.
- A deactivated person still shows as a member ("no longer active") until someone removes them.
- No push/sound notification for new messages — only the unread badge, list counts and the live thread.
- Chats are not purged; no retention policy yet. Audit trail of who removed whom is not recorded.
- Channel "audience" is a snapshot rule (refresh on demand), not live membership.
- If a person has no `name` set on their account they cannot be found in the people picker.

### Phase 10 — what exists
- Migration `149_whatsapp_crm_analytics_cost.sql`: `wa_messages.billable / billing_category / billing_type`, `wa_rate_cards` (versioned, insert-only), report indexes, permissions **`crm.analytics.view`** and **`crm.rates.manage`** (CRM Manager + Super Admin only; agents get neither). **No report tables:** every figure is computed live from `wa_messages`, `wa_campaign_recipients`, `wa_workflow_runs`, `orders`… so a late webhook just makes the next report right. (The plan's `wa_usage_events` was dropped for this reason.)
- **Meta's own billing record is now captured.** The delivery webhook's `pricing` block (billable flag, billed category, type) was already parsed in Phase 1 but never stored. It is now saved on every status event, even a repeat or out-of-order one, and survives status-ladder rules. Verified end to end: signed webhook → API → queue → worker → message DELIVERED with `billable = true, category = MARKETING`.
- **Definitions (written down because they decide every number):** *sent* = SENT/DELIVERED/READ; *delivered* = DELIVERED/READ; *read* = READ; *replied* = the customer wrote back within 24 h of the message; periods are **India calendar days**, from–to inclusive, max 366 days.
- **Cost:** a template message costs money only when **DELIVERED** (Meta's `billable` flag also arrives on the earlier "sent" status, so the flag alone never makes an undelivered or failed message cost). Delivered + Meta says `billable:false` (e.g. free inside the service window) → ₹0. Delivered + Meta says billable → priced by **Meta's category**. Delivered with no Meta record yet → an **estimate** priced by the template's category; the report always says how much of the total is estimated. Price = the rate card in force on the **send date (India)**. A delivered message with no price for its category/date is counted as **"unpriced"** and flagged — never silently ₹0.
- **Prices (rate cards):** per category (Marketing / Utility / Authentication / Service), ₹ per message, from a date. **Insert-only and nothing is pre-filled** — Meta changes prices, so someone who can vouch for them copies them from Meta's India rate card (agreement §13: never hard-coded). A change is a new row with a new date, so past reports do not move; a price already in effect cannot be removed (only one that has not started yet); one price per category per day. Adding a *past-dated* price deliberately re-prices that period (the page says so).
- **Orders & revenue (attribution):** each order is credited **once**, to the **last campaign message or cart reminder** the customer received within the chosen window (1/3/7/14/30 days; default 7) before ordering. "Placed" = not PENDING/CANCELLED/REFUNDED (same rule as the pipeline). **Order-status messages never earn revenue** (they follow an order, they don't cause one). Customers not linked to an account earn no credit. Orders after the report's end date still count toward messages inside it, so a fresh campaign shows its conversions as they arrive.
- **Reports** (`/api/v1/admin/crm/analytics/*`, `rate-cards`): **overview** (funnel, replies, orders, revenue, cost, per-day series, split by campaign / automatic / sent-by-a-person, opt-outs, top failure reasons), **breakdown** by campaign / automatic message / template (delivery, read, reply %, orders, revenue, cost, cost per order, ₹ back per ₹1; unpriced warnings; CSV download with spreadsheet-formula protection), **inbox & team** (typical and 90th-percentile reply time, % answered within 15 min, bot vs people vs unanswered, per-person messages / chats / first replies / typical first reply, bot outcomes), **cost & prices**. History from deleted workflows is kept and folded into one "Deleted …" row.
- Dashboard: **Analytics** page (`/whatsapp-crm/analytics`; period presets + custom range + order window; six tabs), with warnings when no prices exist or some messages are unpriced.
- Tests: +36 rule tests, +30 real-DB tests against a **hand-worked dataset** (funnel, replies, cost under a mid-period price change, last-touch credit, shorter/longer windows, excluded order statuses, templates/campaigns/workflows breakdowns, inbox response times, Meta pricing webhooks, rate-card rules), 35-check HTTP matrix (401 even with a bad query, 403 for agents, validation, 409/404), +25 UI tests. Three deliberate breakages (credit order-status messages, first-touch instead of last, charge Meta-free messages) were each caught. **A live run with seeded data found three real bugs that are now fixed with regression tests:** (1) a SENT-but-undelivered message flagged billable was charged — caught by cross-checking the page's cost against an independent SQL query (₹21.10 vs ₹20.24); (2) a price starting "today" in India showed "Starts later" because "today" was taken in UTC; (3) a flood of separate "(deleted)" rows for removed workflows. Backend: same pre-existing failures as untouched HEAD (the random property tests vary between runs), 0 new; dashboard: same legacy failing files.
- CRM router authentication now runs in `onRequest` (like team chat), so an unauthenticated request gets 401 before any validation error.

### Known limits / open items (Phase 10)
- **Prices must be entered by hand** from Meta's rate card; until then costs show ₹0 with a banner. (Deliberate — see above.)
- Cost is an **estimate** for messages whose Meta billing record has not arrived; Meta's invoice remains the authority. India volume tiers / rate-limits, free entry-point conversations and Meta's own free-tier allowances are not modelled.
- Revenue attribution is **last-touch within a window, by phone-linked account** — a correlation, not proof the message caused the order. Customers who order without a linked WhatsApp contact are invisible here.
- Reply time is wall-clock (includes nights/holidays); there are no per-store or per-area cuts, no A/B comparison, no scheduled/emailed reports and no PDF export (CSV only).
- Ad (Click-to-WhatsApp) attribution is not built — `wa_contacts.referral` is stored but not reported on.
- Reports run live over `wa_messages`; fine to hundreds of thousands of messages per period, but a nightly roll-up would be the next step if it grows far beyond that.

### Phase 11 — what exists
- Migration `150_store_fulfillment_pos.sql`: `shop_staff.pos_station` (PICKER / PACKER / empty = all-round — a **station**, not new `shop_staff.role` values, so the RBAC vocabulary is untouched), `pos_fulfillments`, `pos_lines` (pick list snapshotted when picking starts), `pos_scans` (every attempt, accepted or not), `pos_printers`, `pos_print_jobs`, `pos_handovers`, `pos_events` (audit trail), `pos_attention_resolutions`. **"Where an order is" is derived** (order status + fulfillment + current rider assignment), never stored twice.
- **Drives the existing systems, does not replace them:** status moves (CONFIRMED → PREPARING → PACKED) go through `ShopOrdersService`; riders are assigned through `FinalizeAssignmentService` (the only writer of pickup tokens); the rider's QR scan stays in the rider app and the store only records the handover beside it. Handover is **refused until the rider has scanned the package QR** (409 "has not scanned yet").
- Backend `src/modules/pos/` at `/api/v1/pos/*` (auth in `onRequest`, shop-scoped, canonical `shop_orders.*` permissions + a station check): `me`, `board`, `orders/:id` (+`timeline`), `assign`, `start-pick`, `scan`, `lines/:id/confirm|missing|decision`, `finish-pick`, `start-pack`, `finish-pack`, `rider`, `handover`, `riders`, `staff`, `printers` (+heartbeat/test), `print/jobs` (claim / document / result / retry / reprint), `attention` (+resolve), `performance`. Realtime: content-free `pos:update` to `shop:{id}` + `hq:global`.
- Rules: Picker can only pick; Packer packs, hands over, reprints; viewers see only; managers do everything. A **wrong scan is never accepted** — it is logged and counted. Manual confirm ("by hand") is allowed but counted. A missing item must get a manager's decision (replace / remove / refund) before picking can finish. Late thresholds: New 5 min, Picking 20, Packing 15, Packed-no-rider 5. A print job is PRINTED only when a station says so; stuck jobs expire after 120 s; max 5 attempts. Needs-Attention is derived live (missing item, wrong scan, delay, no rider, print failed, rejected QR…); only "dealt with" is stored.
- Labels (one per package) are queued when a rider is assigned (they carry the pickup QR); the invoice is queued when packing finishes.
- Dashboard (`/pos/*`, sidebar section **FULFILLMENT**): **Live board** (7 lanes, late highlighting, printing status, order search), **Order work screen** (scan box that keeps focus and beeps on a wrong scan, per-line confirm / "can't find it" / manager decision, blockers list, package count, people + rider pickers, handover, print jobs with retry/reprint, history), **Needs attention**, **Printing** (add printers, "Print from this computer" turns the tab into the print station: heartbeat → claim → fetch page → print from a hidden frame → report), **Team & performance** (stations, pick/pack times, scan mistakes, handovers, rider wait). HQ must pick a store first.
- Tests: 45 rule/print unit + 65 real-DB (roles, flows, concurrency, handover gating, print queue, attention, performance) + 14 dashboard UI/helper tests. **Live pass in a real browser** (HQ admin on a seeded store): wrong scan banner → pick → pack (scan + by-hand) → 2 packages → rider assignment queued 2 labels + invoice → handover refused until QR scanned (clear toast) → handover recorded after the scan; print station printed the invoice and the server marked it PRINTED; 401/403 matrix on 5 routes. The live pass found two UI bugs, fixed: "(2000%)" mistake rate (server already sends a percentage) and the Hand-over button staying after handover. Dashboard failures remain the same legacy files as before (login, shops, RBAC, orders, customers…), 0 new.

### Known limits / open items (Phase 11)
- The print station is a **browser tab** on the PC with the printer (the browser's print dialog picks the device). A silent network/ESC-POS agent can use the same queue API later. Not tested with a real printer.
- A queued job with no printer chosen is printed by whichever station is on.
- The rider's QR scan was simulated in the live pass (DB update on a test token); the real scan is in the rider app and was not exercised here.
- Customer-side effects of a "Replace / Remove / Refund" decision beyond recording it were not re-verified in the live pass (covered by the DB tests).
- No sidebar permission gating for the FULFILLMENT section (pages show a message for roles without access), same as the CRM section.

### Phase 12 — what exists
- Migration `151_procurement_and_catalog_bulk.sql`: `vendors`, `procurement_entries`, `procurement_allocations`, `procurement_adjustments`, `procurement_events`, `catalog_bulk_batches`, `catalog_bulk_rows`; the `stock_movements.type` list gains `PROCUREMENT_RECEIPT`, `PROCUREMENT_REVERSAL`, `BULK_UPDATE` (also added to the three places that list the vocabulary); permissions `procurement.view`, `procurement.manage`, `catalog.bulk`, `analytics.business` + a **Procurement Manager** role (and the legacy Super Admin). **Business Analytics adds no tables** — computed live.
- **Stock still moves through ONE audited path** (`ShopProductsRepository.applyStockChange` → `stock_movements`), in the same transaction as the procurement / bulk row, then the same storefront caches are cleared. Whole units only (store stock is an INTEGER).
- **Procurement** (`/api/v1/admin/procurement/*`, dashboard `/procurement`): purchase entry (product, vendor — created on the fly, ordered / received / damaged quantities, unit price, total, date, invoice, receiving note), **central or dedicated-store** purchases, **multi-store split** (all-or-nothing, locked so two people cannot take the same stock, can never exceed what is available; store stock rises immediately and the store's cost price can follow), **reverse a split** (refused if the store already sold / wrote off part), **returns / damage / wastage / authorised adjustments / B2B supply** (from central stock or from a store that received it; each needs a reason), **B2B reservation** (reserved stock cannot go to retail stores until released), cancel (only an untouched purchase). Vendor view (value, average price, shortage, damage, share, product mix) and **reconciliation** (procured → damaged at door → sent to stores → central adjustments → still central → written off at stores → sold → in stores now, purchase cost beside sales value).
- **Bulk catalog** (`/api/v1/admin/catalog-bulk/*`, dashboard `/catalog-bulk`): Excel / CSV with **preview before apply** — product by SKU / barcode / ID, store by branch code; stock (new total), retail / sale / wholesale / cost price, availability, max per order, low-stock alert; blank = no change, `-` = clear a price. Row-level errors; apply is **blocked while errors exist unless the person explicitly skips them**, a final confirmation shows the totals, one batch can be applied once (even by two people at the same moment), and an apply refuses as a whole if a price / availability changed since the preview. **Stock is set at the moment of applying** (customers' orders move it all day). Template and "current catalog" downloads (the export uploads back as "no changes"). Separate **assign / switch on / switch off** tool with a dry run.
- **Business Analytics** (`/api/v1/admin/business-analytics/*`, dashboard `/business-analytics`): Today / 7 / 30 / custom, All stores / one store, All / B2B / B2C. Eight cards (gross sales, net revenue, procurement cost, commission, refunds, returns, cancelled value, tracked loss), daily chart, top & trending products (with repeat buyers and growth), top customers (B2B and B2C separate, repeat rate), store performance (orders, sales, refunds, returns, cancellations, fulfilment minutes, stock in / sold / damaged), B2B vs B2C, vendors, reconciliation. **Definitions are returned with the data and shown on the page**: gross = orders placed (not pending / cancelled) before refunds; net = gross − refunds; refunds counted once per order on the day refunded (cancelled orders excluded); cancelled value = cancelled **after** confirmation (an expired unpaid order is not leakage); commission = delivered orders' subtotal × the store's rate (same formula as settlements); returns = goods back into stock valued at the price paid; tracked loss = damage at receiving + damage / wastage / authorised adjustments + damaged stock written off at stores (vendor returns and B2B supply are not losses); B2B = the order carries a business GST snapshot or the B2B credit flag.
- Access: `GET /procurement/me` tells the dashboard what the person may use. The permission check runs before body validation, so a person without the permission gets 403 (not a 400 that hints at the shape). Sidebar section **BUSINESS** (Business Analytics, Procurement, Bulk Catalog).
- Tests: 28 + 23 rule unit tests, 27 procurement + 20 bulk + 26 analytics (one **hand-worked day**, every expected figure worked out on paper in the test) + 15 HTTP real-DB tests, 19 dashboard tests. **Live pass in a real browser** (HQ admin, seeded stores): analytics cards matched an independent SQL (gross 470 / commission 35 / refunds 40 / procurement cost 252 / loss 28); recorded a purchase with a shortage and damage; split 5 + 3 across two stores (stock 5→10 and 0→3, store switched on, cost price 28, two ledger rows); the split dialog refused 38 when 8 were available; bulk upload with good + bad rows → preview → apply blocked → skip errors → confirm → stock 10→20 through the ledger, price 45 / sale 40, audit row. Backend: same pre-existing failures (22 in 9 files), 0 new; dashboard: same 11 legacy files, 0 new.

### Known limits / open items (Phase 12)
- Procurement quantities are **whole units**. Fractional purchases (e.g. 2.5 kg of a "1 kg" product) must be entered in the product's own unit.
- Stock is **not tracked per purchase batch**, so "sold" and "in stores now" in reconciliation are per product across all stores — read them beside the batch totals.
- Refunds come from approved refund requests and gateway refunds; a refund to the wallet recorded elsewhere is not included. Returns exist only where a stock "return" was recorded.
- Commission uses the store's **current** rate (like settlements), not the rate at the time of the order.
- Bulk sheets: one product per row (SKU / barcode / ID), up to 5,000 rows, one sheet at a time. Product names in a sheet are ignored (SKU is the key).
- Reserving stock for B2B is a hold on central stock with a note; it is not yet linked to a specific B2B order or customer account record, and "Supplied to a B2B order" is recorded by hand.
- No scheduled / emailed reports and no PDF / Excel export of the analytics tables (the screens only); the Business Analytics store filter is for HQ users — a store-level login does not get a store-only version yet.
- No sidebar permission gating for the BUSINESS section (pages show a "not authorised" screen), same as CRM and FULFILLMENT.

### Add-on — messaging a customer from their profile (2026-10-02)
- **Customers → click a customer → profile** now has **Messages sent to this customer** (tabs: *Sent personally*, *All notifications*, *WhatsApp*) and a **WhatsApp Message** button next to *Send Notification*.
- **Fix:** "Send Notification" used to do only a live socket emit — it was not saved and no phone push went out, so it reached only a customer with the app open at that moment and left no record. It now goes through `NotificationsService.sendNotification` (saved in the customer's in-app inbox as `ADMIN_MESSAGE` with the sender's name, shown live, and sent as a push to their registered devices). History: `GET /api/v1/admin/customers/:id/notifications?personal=&limit=`.
- **WhatsApp from the profile** reuses the CRM (no second sender): `POST /api/v1/admin/crm/customers/:userId/conversation` (needs `crm.inbox.reply`) finds or creates the customer's contact + conversation (source `APP`, matched to the account by number; **creating it never opens the 24-hour window**), `GET …/customers/:userId/thread` (needs `crm.inbox.view`) reads the history. Sending then uses the existing inbox rules: free text only while the customer's 24-hour window is open, otherwise an **approved template**; opted-out customers are blocked from marketing templates; agents only see their own / unassigned chats.
- The dialog shows the **WhatsApp configuration status** and exactly which server settings are missing (`WHATSAPP_ENABLED`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`; webhook `WHATSAPP_VERIFY_TOKEN` / `META_APP_SECRET` for replies and delivery ticks) and disables sending until they are set.
- Tests: 16 real-DB / HTTP + 14 dashboard. Live pass in a real browser: personal notification saved and listed with the sender; WhatsApp dialog showed the number, the "not connected" notice and the closed window; DB confirmed the contact was linked and the window never opened.
- Limits: a customer who has never written to us can only receive an **approved template** (WhatsApp rule); until Meta credentials are set nothing can actually be sent; "seen" on a notification means the customer app marked it read.

### Add-on — WhatsApp Settings page (2026-10-02)
- **Where:** sidebar → WhatsApp CRM → **WhatsApp Settings** (`/whatsapp-crm/settings`), inside the WhatsApp section (not the main Settings). Needs the new permission `crm.settings.manage` (CRM Manager + Super Admin; migration 152).
- **Enter the Meta values in the dashboard instead of `.env`:** Phone number ID, WhatsApp Business Account ID, Access token, App Secret, Verify token (can be generated), App ID (optional). Table `wa_settings` (one row). **Secrets are encrypted** (AES-256-GCM, key `SETTINGS_ENCRYPTION_KEY`, else derived from `JWT_ACCESS_SECRET`) and **never sent back** — the page shows only "Saved · EAAG…aaaa". A value saved here beats the same value in `.env`; anything not saved falls back to `.env`, so existing servers keep working. Changing the encryption key means re-entering the secrets (unreadable ones are treated as not set, nothing crashes).
- **Everything now reads the saved settings**: a lazy Meta client (`dynamic-client.js`) looks credentials up on each call through a 10-second cache, so the API **and the separate worker** pick up a change without a restart; the webhook handshake / signature check / on-off switch use them too (`WhatsappSettingsService.resolved()`).
- **Save & test connection → automatic connect:** the test asks Meta (real Graph calls): token + Phone number ID (this is the "200" that decides *Connected*), Business Account, message templates, token lifetime (needs App ID + App Secret — warns when a 24-hour temporary token is about to expire, lists permissions), webhook (last event received), and optionally sends Meta's sample `hello_world` message to a number. A pass marks **CONNECTED and switches WhatsApp on**; a failure records why and leaves the on/off state alone (a working setup that breaks is not silently switched off).
- **Errors in plain language** (`meta-errors.js`): each failure gives a title, what happened, numbered steps to fix it, and collapsible technical details (HTTP status, Meta code / sub-code, trace id) with "Copy for support". Covers expired / invalid / cancelled token, wrong or missing IDs (and **recognises a Business Account ID pasted into the Phone number ID box and suggests the right ID**), missing permissions, rate limits, restricted account, no payment method, test-mode recipient not on the allowed list, unregistered number, and network problems (timeout / DNS / blocked).
- **Also on the page:** a status hero (state, verified name + number, quality, daily limit, token), the **webhook card** (Callback URL + Verify token with copy buttons, Meta steps, last event), **Usage & charges** (this month's sent / delivered / failed, estimated charges by message type, missing-price warning, how Meta bills — same figures as Analytics), a "where do I find this in Meta" guide, switch on/off, remove saved details (asks first).
- **Safety:** test is rate-limited (8 / minute / person); every save/test/switch is audited by field name only; no response ever contains a secret (tested). CRM routes now check the permission **before** validating the body (an unauthorised person gets 403, not a 400).
- Tests: 33 unit (rules, error explainer, connection checks against a fake Meta) + 21 real-DB / HTTP against a local fake Graph API + 15 dashboard. Live pass in a real browser: wrong token → plain-language failure; right token → Meta answered → connected automatically; DB showed the token encrypted. The live pass found one bug, fixed: a just-saved secret stayed in its input box.
- Limits: Meta's API cannot be checked from here with real credentials (only against a fake of Graph's responses, shaped from Meta's documented fields and error codes) — the first real test with the owner's credentials is the true confirmation. The webhook "connected" check can only report whether events have arrived; it cannot verify the callback URL on Meta's side.
