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

## 2. Pictures in a template (the simple way to think about it)

**Think of it like a photo frame.** Meta approves the *frame* (the template with an image slot) one time. After that, you can put a *different photo* in the frame for every message. You never need Meta to approve the frame again just because the photo changed.

So for Navratri you create **one** template with an image slot. You do not create a new template for each festival picture.

### Step A — make the frame (once)
Templates → New template → Header → **Image / banner** → upload any sample picture → Save and submit to Meta. The sample is only for Meta's review. It is not sent to customers.

### Step B — choose the real picture (every time you use it)
In **Workflows**, **Campaigns** and the inbox **Template** button, an image template asks: **"Which picture should we send?"**

| Choice | What happens | Best for |
| --- | --- | --- |
| **The product the customer left in their cart** (cart reminders only) | Each customer gets a picture of their own item. You can choose "most expensive item" or "a random item". | Abandoned-cart reminders |
| **A product that is on offer today** | The system finds in-stock products with a sale price and picks one at random for each message. Nothing to maintain. | Daily or weekly offer messages |
| **Products I choose** | You pick products. Each message shows one of them at random. | A themed push, e.g. "festival sweets" |
| **My own pictures or banners** | Upload 1 picture (everyone gets it) or many (each message gets a random one). | Navratri, Diwali, big sale banners |

**Backup picture:** optional but recommended. If a customer's cart has no photo, or no product is on sale, we send the backup picture instead of skipping that customer. If you choose no backup and nothing is found, the message is skipped (it is never sent without a picture).

### Good to know
- The picture can be anything. A new Navratri banner, a different product every message — all fine. Meta approved the frame, not the photo.
- But the photo must still follow WhatsApp's commerce policy (no alcohol, tobacco, weapons, adult content, fake claims). Breaking this can lower your quality rating or get the number restricted. The CRM cannot check the picture itself, so use sensible images.
- Pictures are sent as JPEG, up to 5 MB, 1200 px wide. Product photos hosted on Cloudinary are converted automatically, so a WebP or huge photo still works.
- The text part of the message still comes from the approved template. Only the picture changes.
- Image templates cannot be edited after submitting. Create a new one if you need a different layout.
- The Meta **App ID** must be saved in WhatsApp settings so the sample can be uploaded to Meta.

### Example: abandoned cart with the customer's product
1. Template `cart_reminder_picture` (Marketing), image header, body: `Hi {{customer_name}}, you left {{cart_items}} in your Bakaloo cart. Order now and we will deliver it fresh.`, button: Link "Open my cart" → `{{cart_link}}`.
2. Workflows → New → "Cart left behind" → wait 5 minutes → Send that template.
3. Under **Which picture should we send?** choose **The product the customer left in their cart** → most expensive item. Add a backup picture (your Bakaloo logo banner).
4. Switch the workflow on. Every customer now gets their own product's photo.

### Example: Navratri offer to opted-in customers
1. Template `festival_offer_banner` (Marketing), image header, body with a short offer, button "Shop now".
2. Campaigns → New → choose the template → audience → **My own pictures or banners** → upload 3 Navratri banners → Launch.
3. Next week, for Diwali, make a new campaign with the **same template** and Diwali banners. No new Meta approval.

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
- `welcome_how_can_we_help` (Utility) text is in `WHATSAPP_TEMPLATES_TO_SUBMIT.md`. Check Templates for its status.
- Needs deploy: database migration 155 (adds the campaign picture setting), then backend and dashboard.
