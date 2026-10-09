# WhatsApp Auto-reply Bot v2 — chat analysis + plan

> **Status (2026-10-09): Phase A built locally, NOT committed, NOT deployed.** Decision from the owner: **no AI at all** (Phase B dropped). Everything below under "Phase A" exists as migration `156_whatsapp_bot_v2.sql`, `bot-language.js`, the extended `bot.service.js`, new admin endpoints (`/admin/crm/bot/areas|waiting-list|product-words`) and dashboard UI on the Auto-reply Bot page. 664 CRM tests + 139 dashboard CRM tests pass, including a replay of the real chat lines (`tests/integration/whatsapp-crm-bot-v2.db.test.js`). Not done: live browser pass, nudge follow-up (A8), the template/ad fixes at the bottom. Defaults chosen without the owner's answer: price quoting OFF, reply in the customer's language, bot answers 24x7.

Source: read-only export of production chats (4–9 Oct 2026): 34 chats, 141 messages, 56 contacts.
This is a **small, 5-day sample**. Treat the numbers as direction, not proof. Raw CSVs are in `chat-export/` (customer phone numbers — never commit).

## 1. What the chats show

### 1.1 Meta-ad leads (19 chats) — the biggest problem
- Every ad lead opens with one of Meta's pre-filled lines: **"Where are you serviceable?"**, **"How can I order?"** or **"Hi"**. Predictable, so a bot can answer them in seconds.
- **Median wait for the first human reply: 11.2 hours** (fastest ~0, slowest 15.3 h). 11 of 16 replied chats waited more than 6 h; **3 chats never got a reply**. Leads arrive in the evening and at night; the team answers only 10:00–17:30 IST.
- **0 of 19 ad leads have placed an order.** (11 of the 56 contacts ordered, all of them existing app users/imports.)
- Most ad leads get the same 2–3 step script by hand:
  1. "Tamaro Area kyo chhe ?" (asks area, roman Gujarati)
  2. Out of area → "હાલમાં અમારી સેવા માત્ર મોટો વરાછા અને ઉત્રાણ વિસ્તારમાં ઉપલબ્ધ છે." / in area → Play Store + App Store links + "first order par spin kari ne reward melvi ne"
  3. Customer says "Ok" — conversation ends.
- Areas customers named: Mota Varachha ×3, Amroli, Sarthana, Pal, Katargam/Ambatlavdi, Kholvad, Yogi Chowk. **About 6 of 9 were outside the two served areas** — ad targeting is spending money on people who can't order.

### 1.2 How customers write
Gujarati script, roman Gujarati ("Libu no su bhav 6", "Vegetables ni price please"), English, Hinglish, and one-word replies ("Ok", "Aok"). Spelling varies a lot (motavarachha / Mota Varachha / રામ ચોક મોટા varacha). Matching must be fuzzy and cover all three scripts.

### 1.3 Questions bot cannot answer today
- **Price** ("Vegetables ni price", "Libu no su bhav", "શું ભાવ છે 1 કિલો નો") — 4 chats. The team only sends an app link; nobody quotes a price.
- **Product availability** ("સૂકી ડુંગળી મહારાષ્ટ્ર ની") → team: "Maharashtra ni dungali nhi lavata ame".
- **How to order** — answered with app links only, no steps, no mention of the website.

### 1.4 Things that look broken or wasteful
| # | Finding | Evidence |
|---|---|---|
| 1 | **Button taps get no answer.** Customers tap "મોટા વરાછા" / "ઉતરાણ" / "અથવા કોઈ બીજું" on the area template and nothing replies. Some tap all three. | 6 chats, ~12 button taps, no reply to any |
| 2 | **`survey_utility_surat` / `location_survery_by_bakaloo` fail 100%** with error 131009 (parameter invalid). | 5 of 5 sends failed |
| 3 | `area_name_enquiry` blocked by Meta (131049, marketing frequency limit) for 3 contacts. | 3 failures |
| 4 | `hello_world` test template sent to real customers (131058). | 2 failures |
| 5 | Same abandoned-cart reminder sent **twice within 7 minutes** to one customer. | 1 chat |
| 6 | Bare "hi" / "hello" sent by a person to customers who never wrote (no context). | 3 chats |
| 7 | Cart reminder says "Free Delivery above ₹5" — check this is intended. | template text |
| 8 | Noise: a vendor sales pitch, an unsupported message, a Paytm "Money Sent" screenshot. Bot must not reply to these; a person should look at the screenshot. | 3 chats |
| 9 | Language is inconsistent: same question answered in English once, Gujarati script another time, roman Gujarati a third time. | #0 vs #1 |

### 1.5 What the team does well (keep this voice)
Short, polite, asks one thing at a time ("Tamaro Area kyo chhe ?"), answers in the customer's language, gives a reason to install ("spin and win a reward on first order").

## 2. Plan: Bot v2

### Principles
- **Answer instantly, 24×7, in the customer's language.** The salesperson's script becomes the bot's script.
- **Only say things the system knows are true** (serviceable areas, live prices, order status). Never guess a price or area.
- **One question per message, short, human.** No "reply 1–5" menus (current bot) — they feel robotic and nobody on this sample used them.
- **Hand over to a person on any doubt**, with the chat summary filled in, and the person's reply pauses the bot (already built).

### Phase A — Guided sales flow (no AI, rules + data)
1. **Language detection per message** (Gujarati script / roman Gujarati / English / Hindi-Hinglish) → reply in the same one. Stored on the contact.
2. **Area dictionary** (new table `wa_service_areas`: canonical name, aliases in all scripts, serviceable yes/no, optional PIN codes). Seeded with Mota Varachha and Utran. Editable by the CRM manager without a developer. Unknown area → "not sure, a person will confirm" (never auto-reject). Out-of-area → polite no + ask to join the waitlist (store it → tells you which areas to open / where ads are wasted).
3. **Meta-ad opener flow** (triggered by source = META_AD or the pre-filled lines):
   greeting + ask area → in-area: how to order in 3 steps + app links + website + spin reward → out-of-area: waitlist.
4. **Button / list reply handling** — fixes finding #1. Tapping "મોટા વરાછા" continues the flow; "અથવા કોઈ બીજું" asks for the area name.
5. **Price and product answers from the live catalog**: "libu no bhav" → fuzzy product match (Gujarati / roman / English names) → today's price and unit, add "order in the app" link. Not found / not stocked → honest "we don't carry this" (as the team did for Maharashtra onion). Needs a product alias list (Gujarati + roman names) — will be generated from the catalog and reviewed by you.
6. **Order help** — real order status, payment/refund → hand over (already exist; rewritten in the new voice).
7. **Hand-over rules**: images/voice/documents, complaints, anything unmatched twice, vendor/B2B pitches (silent + tag), screenshots of payments. Note shown to the agent: language, area, what was asked.
8. **Follow-up nudge**: if an in-area lead hasn't ordered after N hours, one gentle message (inside the free window; no marketing template cost).
9. **Safety rails kept**: master switch, per-chat hourly cap, quiet period after a human reply, STOP/START consent.

### Phase B — Optional AI for free-text — DROPPED (owner: "no AI")
Earlier decision was "no AI anywhere". Phase A will not cover every free-text question. If you want it: an LLM that may **only** use tool results (area lookup, catalog search, order status, FAQ text you approve) to write the reply in your team's tone, with the same hand-over rules, a **suggest-only mode first** (draft appears in the inbox for an agent to send with one click), and a log of every answer. Cost: a few paise per chat.

### Phase C — Measure and tune
- Test bench: replay the 34 real chats (plus new ones weekly) through the bot and compare with what the team said.
- Dashboard (analytics page already has bot outcomes): first-reply time, leads by area, out-of-area share, orders from ad leads.
- Weekly review of "bot didn't know" questions → add answers.

### Fixes to ship alongside (no bot needed)
- Investigate 131009 on the survey templates (parameter/header mismatch) before sending that template again.
- Dedupe abandoned-cart reminder (one per cart per N hours).
- Block `hello_world` and other test templates from real customers.
- Rethink the `area_name_enquiry` marketing blast (frequency cap) — reply-to-lead flow replaces most of it.
- Review **Meta ad targeting**: restrict to Mota Varachha / Utran PIN codes and radius.

## 3. Decisions needed from you
1. **Phase B (AI)** — yes now, yes later, or never?
2. **Service areas** — only Mota Varachha and Utran today? Any area opening soon? Delivery timings and minimum order, free-delivery rule, spin reward wording (so the bot says exactly what is true).
3. **Price answers** — OK to quote live app prices in chat, or only send the app link?
4. **Language** — reply in the customer's language (my recommendation), or always Gujarati script?
5. **Hours** — should the bot hand off to people only during 10:00–17:30, with "we'll reply by 10:30 am" after hours?

## 4. Build order
A1 area dictionary + opener flow + button handling → A2 catalog price/product answers → A3 hand-over + nudges → C test bench → (B if approved). Everything stays local and bot-OFF until you review; no production deploy without your word.
