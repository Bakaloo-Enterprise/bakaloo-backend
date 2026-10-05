# WhatsApp templates — images, buttons and Meta's rules

Checked against Meta's "Template components" documentation (updated Jun 2026). Where this guide says "the CRM checks this", the template form already blocks it before anything is sent to Meta.

## 1. Creating a template (Templates → New template)

1. **Name** — lowercase letters, numbers, underscores only (`order_confirmed`). Cannot be changed after Meta has seen it. A deleted name stays reserved for 30 days.
2. **Language** — pick the language the message is written in. A Hindi message needs Hindi selected.
3. **Category** — decides price and approval:
   - **Utility**: a message about something the customer already did (order update, payment, delivery). Cheaper. Must NOT contain offers or promotion, or Meta will move it to Marketing.
   - **Marketing**: offers, coupons, reminders to buy, "we miss you". Costs more. Only send to customers who opted in.
4. **Header** (optional) — None, Text, or Image / banner (see section 2).
5. **Message (body)** — required, up to 1024 characters.
6. **Footer** (optional) — up to 60 characters, no variables.
7. **Buttons** (optional) — see section 3.
8. **Examples** — Meta needs a sample value for every `{{variable}}`. Customers never see them.
9. **Save and submit to Meta**. Status goes In review → Approved (minutes to a day). Use **Sync with Meta** to refresh.

### Body rules (the CRM checks these)
- Variables use names like `{{customer_name}}`, `{{order_number}}`, not `{{1}}`.
- Do not start or end the message with a variable.
- Two variables cannot sit side by side. Put words between them.
- Do not use too many variables for a short message. Meta rejects "mostly variable" text.
- Do not put a variable in the footer.

### What makes Meta reject a template
- Marketing content in a Utility template.
- Asking for passwords, card numbers, OTPs, Aadhaar, etc.
- Threats, adult content, or anything illegal. Misleading claims ("guaranteed", fake urgency).
- Shortened or hidden links (bit.ly etc.). Use your own domain such as bakaloo.in.
- Spelling or grammar mistakes, or a body that is only variables.
- Messages that do not match the examples you gave.

## 2. Image / banner in a template

You can add a product photo or offer banner at the top of the message.

**How it works (two parts):**
1. **When you create the template** you upload a *sample* image. Meta reviews the sample to approve the template. In the form choose Header → **Image / banner** → **Upload sample image**. The CRM sends it to Meta for you.
2. **When you actually send** (inbox Template button, a campaign, or a workflow) you pick the *real* image each time — for example today's offer banner or a product photo. Use the **Upload product image / banner** button, or paste an https link.

**Image rules (Meta):**
- JPEG or PNG only, up to **5 MB**.
- Best shape is landscape about **1.91 : 1** (for example 1200 × 628). Square also works.
- Do not put important text near the edges. WhatsApp may crop.
- The image must not break Meta's commerce policy (no alcohol, tobacco, weapons, adult content, misleading claims).
- Video (MP4, up to 16 MB) and PDF documents (up to 100 MB) are also allowed by Meta. The form currently offers image only.
- Only one header per template: text OR image, not both.

**Requirement:** the Meta **App ID** must be saved in WhatsApp settings. Without it the sample upload fails with a message saying so.

**Notes:**
- A template with an image header cannot be edited after submission in this CRM. Create a new one, or edit it in Meta's WhatsApp Manager.
- Marketing templates with a banner often get better engagement, but cost the same as other Marketing messages.

## 3. Buttons

Buttons make it easy to reply or act. A template can have up to **10 buttons in total**. Label: up to **25 characters**.

| Button | Limit | What it does | Good Bakaloo use |
| --- | --- | --- | --- |
| **Quick reply** | up to 10 | Customer taps and a reply is sent to you immediately | "Track my order", "Talk to support", "Stop offers" |
| **Link (URL)** | up to 2 | Opens a web page | "Shop now" → https://bakaloo.in , "Track order" → https://bakaloo.in/orders/{{order_id}} |
| **Call (phone)** | 1 | Calls a number | "Call store" → +91 99249 90627 |

**Rules (the CRM checks these):**
- Link must start with `https://`. A link can contain **one** variable and it must be at the very **end** (for example `https://bakaloo.in/orders/{{order_id}}`). Give an example value for it.
- Quick-reply buttons must be grouped together — all first or all last. Not mixed in the middle (valid: Quick, Quick, Link, Call. Invalid: Quick, Link, Quick).
- Phone numbers need the country code (`+919876543210`).
- With more than 3 buttons WhatsApp shows two and a "See all options" button.
- Templates with 4 or more buttons, or a quick reply together with another button type, cannot be viewed on WhatsApp Desktop. People are asked to open them on their phone. Keep to 1–3 buttons for the best experience.

**Marketing templates:** always include an opt-out button such as quick reply **"Stop offers"** (or footer "Reply STOP to opt out"). This keeps your quality rating green. Remember to treat a "Stop offers" reply as do-not-contact.

**How to add one:** in the template form, press **+ Quick reply**, **+ Link** or **+ Call** under Buttons, then fill in the label (and link or phone).

## 4. Rules for sending

- **Inside 24 hours** of the customer's last message you can send free-form text.
- **After 24 hours** (or to someone who never wrote to you) you can only send an **approved template**.
- **`hello_world` is Meta's sample.** It works only from Meta's test numbers. The CRM blocks it for your real number.
- **Marketing needs opt-in.** The CRM refuses marketing to customers who opted out and holds marketing during quiet hours (9 pm – 9 am IST).
- **Quality rating:** if many customers block or report you, Meta lowers your quality and daily limit (your tier is currently 250 customers/day). Send relevant messages only.
- **Cost:** Marketing > Utility. Enter Meta's current India prices under Analytics → Cost & prices to see charges.

## 5. Ready examples

**Utility with a button**
- Name: `order_out_for_delivery`
- Body: `Hi {{customer_name}}, your Bakaloo order {{order_number}} is out for delivery and will reach you in about {{eta_minutes}} minutes.`
- Button: Link "Track order" → `https://bakaloo.in/orders/{{order_id}}`

**Marketing with banner and buttons**
- Name: `weekend_offer_banner`
- Header: Image / banner (sample banner)
- Body: `Hi {{customer_name}}, fresh fruits and vegetables are on offer this weekend at Bakaloo. Order now and get them delivered to your door.`
- Footer: `Reply STOP to opt out`
- Buttons: Link "Shop now" → `https://bakaloo.in` , Quick reply "Stop offers"

## 6. Current status
- `welcome_how_can_we_help` (Utility) has been written for submission. Check Templates for its status.
