-- 156_whatsapp_bot_v2.sql
--
-- WhatsApp CRM — auto-reply bot v2 (still NO AI). Built from the real chats of 4–9 Oct 2026
-- (docs/WHATSAPP_BOT_V2_PLAN.md). What changes:
--   * Bot answers in the customer's language: English, Gujarati script, or Gujarati in English letters.
--   * Delivery areas are DATA (wa_service_areas): the bot knows which areas we serve, understands spelling
--     variants, and records the area of every customer (also builds the "waiting for us" list).
--   * Product words (Gujarati / Roman / English) map to catalog search terms (wa_product_aliases).
--   * New rule types: AREA_YES, AREA_NO, AREA_ASKED, PRODUCT.  New action: IGNORE (stay silent, e.g. "Ok").
--   * The numbered "reply 1-5" menu is replaced by the salesperson flow: greet -> ask area -> how to order.
-- Everything is additive; the master switch stays OFF until a manager turns it on.
-- Starter rules are only rewritten when nobody has edited them (updated_at = created_at).

-- ─── Delivery areas ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_service_areas (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           VARCHAR(80) NOT NULL,
  name_gu        VARCHAR(80),
  aliases        TEXT[] NOT NULL DEFAULT '{}',
  is_serviceable BOOLEAN NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  position       INTEGER NOT NULL DEFAULT 100,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_service_areas_name ON wa_service_areas (lower(name));

INSERT INTO wa_service_areas (name, name_gu, aliases, is_serviceable, position) VALUES
  ('Mota Varachha', 'મોટા વરાછા', ARRAY['motavarachha','mota varachha','mota varacha','mota varachchha','moto varachha','મોટો વરાછા','મોટા વરાછા','મોટા varacha','મોટા varachha'], TRUE, 10),
  ('Utran', 'ઉતરાણ', ARRAY['utran','uttran','utaran','uttaran','ઉત્રાણ','ઉતરાણ'], TRUE, 20),
  ('Amroli', 'અમરોલી', ARRAY['amroli','amrauli'], FALSE, 100),
  ('Sarthana', 'સરથાણા', ARRAY['sarthana','sarthna','sarthana jakatnaka','sarthana jakat naka','સરથાણા જકાતનાકા'], FALSE, 100),
  ('Pal', 'પાલ', ARRAY['pal','pal gam'], FALSE, 100),
  ('Katargam', 'કતારગામ', ARRAY['katargam','katar gam'], FALSE, 100),
  ('Ambatalavdi', NULL, ARRAY['ambatalavdi','ambatlavdi','aambatlavdi','amba talavdi','આંબાતલાવડી'], FALSE, 100),
  ('Kholvad', NULL, ARRAY['kholvad','kholwad','ખોલવડ'], FALSE, 100),
  ('Nana Varachha', 'નાના વરાછા', ARRAY['nana varachha','nana varacha','nanavarachha'], FALSE, 100),
  ('Adajan', 'અડાજણ', ARRAY['adajan'], FALSE, 100),
  ('Vesu', 'વેસુ', ARRAY['vesu'], FALSE, 100),
  ('Piplod', 'પીપલોદ', ARRAY['piplod'], FALSE, 100),
  ('Udhna', 'ઉધના', ARRAY['udhna','udhana'], FALSE, 100),
  ('Sachin', 'સચિન', ARRAY['sachin'], FALSE, 100),
  ('Althan', 'અલથાણ', ARRAY['althan'], FALSE, 100),
  ('Limbayat', 'લિંબાયત', ARRAY['limbayat'], FALSE, 100),
  ('Pandesara', 'પાંડેસરા', ARRAY['pandesara'], FALSE, 100),
  ('Rander', 'રાંદેર', ARRAY['rander'], FALSE, 100),
  ('Parvat Patiya', 'પર્વત પાટિયા', ARRAY['parvat patiya','parvat patia'], FALSE, 100),
  ('Simada', 'સીમાડા', ARRAY['simada'], FALSE, 100),
  ('Kapodara', 'કાપોદ્રા', ARRAY['kapodara','kapodra'], FALSE, 100),
  ('Bamroli', 'બમરોલી', ARRAY['bamroli'], FALSE, 100),
  ('Puna', 'પુણા', ARRAY['puna gam','puna'], FALSE, 100),
  ('Dumas', 'ડુમસ', ARRAY['dumas'], FALSE, 100)
ON CONFLICT DO NOTHING;

-- ─── Product words ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_product_aliases (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  alias       VARCHAR(60) NOT NULL,        -- what customers type, lower case
  search_term VARCHAR(60) NOT NULL,        -- English word searched in the catalog (products.name ILIKE)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_product_aliases_alias ON wa_product_aliases (lower(alias));

INSERT INTO wa_product_aliases (alias, search_term)
SELECT lower(a), t FROM (VALUES
  ('lemon','lemon'),('limbu','lemon'),('libu','lemon'),('lebu','lemon'),('nimbu','lemon'),('લીંબુ','lemon'),('લીંબુડી','lemon'),
  ('onion','onion'),('dungli','onion'),('dungari','onion'),('dungri','onion'),('kanda','onion'),('pyaz','onion'),('ડુંગળી','onion'),('કાંદા','onion'),
  ('potato','potato'),('bataka','potato'),('batata','potato'),('aloo','potato'),('બટાકા','potato'),('બટેટા','potato'),
  ('tomato','tomato'),('tameta','tomato'),('tamata','tomato'),('ટામેટા','tomato'),
  ('garlic','garlic'),('lasan','garlic'),('lahsun','garlic'),('લસણ','garlic'),
  ('ginger','ginger'),('adu','ginger'),('aadu','ginger'),('આદુ','ginger'),
  ('coriander','coriander'),('kothmir','coriander'),('dhaniya','coriander'),('કોથમીર','coriander'),
  ('chilli','chilli'),('chili','chilli'),('marcha','chilli'),('marchu','chilli'),('mirchi','chilli'),('મરચા','chilli'),('મરચાં','chilli'),
  ('capsicum','capsicum'),('shimla mirch','capsicum'),('કેપ્સીકમ','capsicum'),
  ('cauliflower','cauliflower'),('flower','cauliflower'),('ફ્લાવર','cauliflower'),
  ('cabbage','cabbage'),('kobi','cabbage'),('kobij','cabbage'),('કોબીજ','cabbage'),
  ('brinjal','brinjal'),('ringan','brinjal'),('ringna','brinjal'),('baingan','brinjal'),('રીંગણ','brinjal'),
  ('okra','okra'),('ladyfinger','okra'),('bhinda','okra'),('bhindi','okra'),('ભીંડા','okra'),
  ('spinach','spinach'),('palak','spinach'),('પાલક','spinach'),
  ('carrot','carrot'),('gajar','carrot'),('ગાજર','carrot'),
  ('cucumber','cucumber'),('kakdi','cucumber'),('કાકડી','cucumber'),
  ('bottle gourd','gourd'),('dudhi','gourd'),('દૂધી','gourd'),
  ('bitter gourd','bitter'),('karela','bitter'),('કારેલા','bitter'),
  ('peas','peas'),('vatana','peas'),('matar','peas'),('વટાણા','peas'),
  ('beetroot','beetroot'),('beet','beetroot'),('બીટ','beetroot'),
  ('radish','radish'),('mula','radish'),('મૂળા','radish'),
  ('coconut','coconut'),('nariyal','coconut'),('nariyel','coconut'),('નારિયેળ','coconut'),
  ('banana','banana'),('kela','banana'),('કેળા','banana'),
  ('apple','apple'),('safarjan','apple'),('સફરજન','apple'),
  ('mango','mango'),('keri','mango'),('કેરી','mango'),
  ('papaya','papaya'),('papaiyu','papaya'),('પપૈયું','papaya'),
  ('watermelon','watermelon'),('tarbuch','watermelon'),('તરબૂચ','watermelon'),
  ('orange','orange'),('santra','orange'),('સંતરા','orange'),
  ('grapes','grapes'),('draksh','grapes'),('દ્રાક્ષ','grapes'),
  ('pomegranate','pomegranate'),('dadam','pomegranate'),('દાડમ','pomegranate'),
  ('milk','milk'),('dudh','milk'),('દૂધ','milk')
) AS v(a, t)
ON CONFLICT DO NOTHING;

-- ─── What the bot remembers about a customer ────────────────────────
ALTER TABLE wa_contacts
  ADD COLUMN IF NOT EXISTS bot_language    VARCHAR(3) CHECK (bot_language IN ('en','gu','gl')),
  ADD COLUMN IF NOT EXISTS service_area_id UUID REFERENCES wa_service_areas(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS area_text       VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_wa_contacts_service_area ON wa_contacts(service_area_id) WHERE service_area_id IS NOT NULL;

-- ─── Settings: links, price switch, fallback in 3 languages ─────────
ALTER TABLE wa_bot_settings
  ADD COLUMN IF NOT EXISTS fallback_text_gu TEXT,
  ADD COLUMN IF NOT EXISTS fallback_text_gl TEXT,
  ADD COLUMN IF NOT EXISTS play_store_url   TEXT NOT NULL DEFAULT 'https://play.google.com/store/apps/details?id=com.bakaloo.india',
  ADD COLUMN IF NOT EXISTS app_store_url    TEXT NOT NULL DEFAULT 'https://apps.apple.com/in/app/bakaloo/id6756962834',
  ADD COLUMN IF NOT EXISTS website_url      TEXT NOT NULL DEFAULT 'https://www.bakaloo.in',
  -- OFF by default: prices differ per shop, so the bot only says "yes we have it" until a manager opts in.
  ADD COLUMN IF NOT EXISTS quote_prices     BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE wa_bot_settings SET
  fallback_text = $$Thank you for your message 🙏 We have passed it to our team and they will reply here as soon as possible.$$
 WHERE fallback_text = 'Thanks for your message. A member of our team will reply to you shortly.';
UPDATE wa_bot_settings SET
  fallback_text_gu = COALESCE(fallback_text_gu, $$તમારા સંદેશ બદલ આભાર 🙏 અમે તે અમારી ટીમને મોકલી દીધો છે, તેઓ શક્ય તેટલા જલદી અહીં જવાબ આપશે.$$),
  fallback_text_gl = COALESCE(fallback_text_gl, $$Tamara sandesh badal aabhar 🙏 Ame te amari team ne mokli didho chhe, teo shakya teta jaldi ahi jawab aapshe.$$);

-- ─── Rules: new columns, types and actions ──────────────────────────
ALTER TABLE wa_bot_rules
  ADD COLUMN IF NOT EXISTS reply_text_gu TEXT,
  ADD COLUMN IF NOT EXISTS reply_text_gl TEXT,
  -- The reply ends with "which area are you in?": the next short unknown answer is treated as an area name.
  ADD COLUMN IF NOT EXISTS asks_area     BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE wa_bot_rules DROP CONSTRAINT IF EXISTS wa_bot_rules_match_type_check;
ALTER TABLE wa_bot_rules ADD CONSTRAINT wa_bot_rules_match_type_check
  CHECK (match_type IN ('CONTAINS','EXACT','STARTS_WITH','PINCODE','AREA_YES','AREA_NO','AREA_ASKED','PRODUCT'));
ALTER TABLE wa_bot_rules DROP CONSTRAINT IF EXISTS wa_bot_rules_action_check;
ALTER TABLE wa_bot_rules ADD CONSTRAINT wa_bot_rules_action_check
  CHECK (action IN ('REPLY','REPLY_HANDOFF','HANDOFF','OPT_OUT','OPT_IN','IGNORE'));
ALTER TABLE wa_bot_rules DROP CONSTRAINT IF EXISTS chk_bot_rule_keywords;
ALTER TABLE wa_bot_rules ADD CONSTRAINT chk_bot_rule_keywords
  CHECK (match_type IN ('PINCODE','AREA_YES','AREA_NO','AREA_ASKED','PRODUCT') OR cardinality(keywords) + cardinality(exact_keywords) > 0);
ALTER TABLE wa_bot_rules DROP CONSTRAINT IF EXISTS chk_bot_rule_reply;
ALTER TABLE wa_bot_rules ADD CONSTRAINT chk_bot_rule_reply
  CHECK (action IN ('HANDOFF','IGNORE') OR (reply_text IS NOT NULL AND length(btrim(reply_text)) > 0));

-- ─── Old numbered-menu rules are switched off (if untouched) ────────
UPDATE wa_bot_rules SET is_active = FALSE, updated_at = NOW()
 WHERE name IN ('Menu 1 – Delivery area', 'Help / menu', 'Greeting (after hours)', 'Greeting')
   AND updated_at = created_at;

-- ─── Starter rules that stay: add the Gujarati wording (only if untouched) ──
UPDATE wa_bot_rules SET
  reply_text_gu = $$તમને ઓફર્સમાંથી અનસબ્સ્ક્રાઇબ કરી દીધા છે. તમારા ઓર્ડરના મહત્વના અપડેટ તમને મળતા રહેશે. ફરી ચાલુ કરવા કોઈ પણ સમયે START લખો.$$,
  reply_text_gl = $$Tamne offers mathi unsubscribe kari didha chhe. Tamara order na important update malta rahese. Fari chalu karva koi pan samaye START lakho.$$
 WHERE name = 'Unsubscribe from offers' AND updated_at = created_at;
UPDATE wa_bot_rules SET
  reply_text_gu = $$આભાર! હવે તમને Bakaloo ની ઓફર્સ અને અપડેટ મળતા રહેશે. બંધ કરવા કોઈ પણ સમયે STOP લખો.$$,
  reply_text_gl = $$Aabhar! Have tamne Bakaloo ni offers ane update malta rahese. Bandh karva koi pan samaye STOP lakho.$$
 WHERE name = 'Subscribe to offers' AND updated_at = created_at;
UPDATE wa_bot_rules SET
  keywords = keywords || ARRAY['માણસ','વાત કરવી છે','manas sathe','vat karvi chhe','vaat karvi chhe'],
  reply_text_gu = $$ચોક્કસ, હું તમને અમારી ટીમ સાથે જોડું છું. કોઈ ટૂંક સમયમાં અહીં જવાબ આપશે.$$,
  reply_text_gl = $$Chokkas, hu tamne amari team sathe jodu chhu. Koi tunk samay ma ahi jawab aapshe.$$
 WHERE name = 'Talk to a person' AND updated_at = created_at;
UPDATE wa_bot_rules SET
  keywords = keywords || ARRAY['order status','mara order','maro order','mero order','order kya','order kyare','મારો ઓર્ડર','ઓર્ડર ક્યાં','ઓર્ડર ક્યારે'],
  reply_text = $$Hi {{customer_name}}, {{last_order}} For anything else, type 'agent' to talk to our team.$$,
  reply_text_gu = $$નમસ્તે {{customer_name}}, {{last_order}} બીજી કોઈ મદદ માટે 'agent' લખો, અમારી ટીમ જવાબ આપશે.$$,
  reply_text_gl = $$Namaste {{customer_name}}, {{last_order}} Biji koi madad mate 'agent' lakho, amari team jawab aapshe.$$
 WHERE name = 'Order status' AND updated_at = created_at;
UPDATE wa_bot_rules SET
  keywords = keywords || ARRAY['paisa kapai','paisa kapaya','પૈસા કપાયા','પૈસા કપાઈ','પેમેન્ટ'],
  reply_text_gu = $$પેમેન્ટમાં તકલીફ થઈ તે બદલ માફ કરશો. અમારી ટીમ ટૂંક સમયમાં તમારા માટે તપાસ કરશે.$$,
  reply_text_gl = $$Payment ma takleef thai te badal maaf karjo. Amari team tunk samay ma tamara mate check karshe.$$
 WHERE name = 'Payment or refund' AND updated_at = created_at;
UPDATE wa_bot_rules SET
  keywords = keywords || ARRAY['ઓફર','ઓફર્સ','કૂપન','discount code'],
  reply_text = $$You can see our latest offers and coupons in the Bakaloo app. Type 'agent' to talk to our team.$$,
  reply_text_gu = $$અમારી તાજેતરની ઓફર્સ અને કૂપન Bakaloo એપમાં જુઓ. અમારી ટીમ સાથે વાત કરવા 'agent' લખો.$$,
  reply_text_gl = $$Amari taajetar ni offers ane coupon Bakaloo app ma juo. Amari team sathe vaat karva 'agent' lakho.$$
 WHERE name = 'Offers' AND updated_at = created_at;
UPDATE wa_bot_rules SET
  keywords = keywords || ARRAY['samay','સમય','ક્યારે ખુલ્લા','kyare khulla','kyare khule','kyare bandh'],
  reply_text_gu = $$અમે {{business_hours}} ખુલ્લા છીએ.$$,
  reply_text_gl = $$Ame {{business_hours}} khulla chhie.$$
 WHERE name = 'Business hours' AND updated_at = created_at;

-- Note: 'Area not recognised' sits LAST (900) so every specific rule gets first chance at a short reply.
-- ─── New salesperson-style rules (idempotent by name) ───────────────
-- Variables: {{customer_name}} {{area_name}} {{area_text}} {{served_areas}} {{product_info}} {{last_order}}
--            {{business_hours}} {{pincode_result}} {{play_store_link}} {{app_store_link}} {{website}}
INSERT INTO wa_bot_rules (name, position, match_type, keywords, exact_keywords, when_hours, action, reply_text, reply_text_gu, reply_text_gl, asks_area, cooldown_minutes)
SELECT * FROM (VALUES
  ('Ok / acknowledgement', 35, 'EXACT', ARRAY['ok','okay','okk','okey','aok','k','kk','thik','theek','thik chhe','ઓકે','ઠીક છે','ઠીક','સારું','👍'], ARRAY[]::text[], 'ANY', 'IGNORE',
   NULL, NULL, NULL, FALSE, 0),

  ('Thanks', 37, 'CONTAINS', ARRAY['thanks','thank you','thankyou','thx','aabhar','abhar','dhanyavad','આભાર','ધન્યવાદ'], ARRAY[]::text[], 'ANY', 'REPLY',
   $$You're welcome! 😊 If you need anything else, just message us here.$$,
   $$આપનું સ્વાગત છે! 😊 બીજી કોઈ મદદ જોઈએ તો અહીં જ લખો.$$,
   $$Tamaru swagat chhe! 😊 Biji koi madad joiye to ahi j lakho.$$, FALSE, 60),

  ('Choose another area', 44, 'EXACT', ARRAY['other','others','another area','other area','bijo area','biju','બીજું','બીજો વિસ્તાર','અથવા કોઈ બીજું','અથવા કોઈ બીજુ'], ARRAY[]::text[], 'ANY', 'REPLY',
   $$Sure! Please type your area name and I'll check if we deliver there.$$,
   $$ચોક્કસ! કૃપા કરીને તમારા વિસ્તારનું નામ લખો, હું ચકાસી લઉં કે ત્યાં ડિલિવરી થાય છે કે નહીં.$$,
   $$Chokkas! Krupa kari ne tamara area nu naam lakho, hu check kari lau ke tya delivery thay chhe ke nahi.$$, TRUE, 0),

  ('Area we deliver to', 45, 'AREA_YES', ARRAY[]::text[], ARRAY[]::text[], 'ANY', 'REPLY',
   $$Great, we deliver to {{area_name}}! 🎉

How to order:
1️⃣ Download the Bakaloo app
📱 Android: {{play_store_link}}
🍎 iPhone: {{app_store_link}}
2️⃣ Choose your area and add items to the cart
3️⃣ Place your order. You also get a spin & win reward on your first order 🎁

You can order on our website too: {{website}}
Need any help? Just reply here.$$,
   $$વાહ, અમે {{area_name}} માં ડિલિવરી કરીએ છીએ! 🎉

ઓર્ડર કેવી રીતે કરવો:
1️⃣ Bakaloo એપ ડાઉનલોડ કરો
📱 Android: {{play_store_link}}
🍎 iPhone: {{app_store_link}}
2️⃣ તમારો વિસ્તાર પસંદ કરો અને વસ્તુઓ કાર્ટમાં ઉમેરો
3️⃣ ઓર્ડર કરો. પહેલા ઓર્ડર પર સ્પિન કરીને રિવોર્ડ પણ જીતો 🎁

વેબસાઇટ પરથી પણ ઓર્ડર કરી શકો છો: {{website}}
કોઈ મદદ જોઈએ તો અહીં જ લખો.$$,
   $$Wah, ame {{area_name}} ma delivery karie chhie! 🎉

Order kevi rite karvo:
1️⃣ Bakaloo app download karo
📱 Android: {{play_store_link}}
🍎 iPhone: {{app_store_link}}
2️⃣ Tamaro area select karo ane items cart ma add karo
3️⃣ Order karo. Pehla order par spin kari ne reward pan jitso 🎁

Website parthi pan order kari shako chho: {{website}}
Koi madad joiye to ahi j lakho.$$, FALSE, 0),

  ('Area we do not deliver to (yet)', 50, 'AREA_NO', ARRAY[]::text[], ARRAY[]::text[], 'ANY', 'REPLY',
   $$Thank you for telling us 🙏 We don't deliver to {{area_name}} yet. Right now we deliver in {{served_areas}}.

We have noted your area. Reply START and we'll message you as soon as we begin delivering there.$$,
   $$જણાવવા બદલ આભાર 🙏 હાલમાં અમે {{area_name}} માં ડિલિવરી કરતા નથી. અત્યારે અમારી સેવા {{served_areas}} માં ઉપલબ્ધ છે.

અમે તમારો વિસ્તાર નોંધી લીધો છે. START લખો, અમે ત્યાં શરૂ કરીએ ત્યારે તમને જાણ કરીશું.$$,
   $$Janavva badal aabhar 🙏 Haal ame {{area_name}} ma delivery karta nathi. Atyare amari seva {{served_areas}} ma upalabdh chhe.

Ame tamaro area note kari lidho chhe. START lakho, ame tya shuru karie tyare tamne jaan karishu.$$, FALSE, 0),

  ('Area not recognised (team will check)', 900, 'AREA_ASKED', ARRAY[]::text[], ARRAY[]::text[], 'ANY', 'REPLY_HANDOFF',
   $$Thanks! Let me check if we deliver to {{area_text}}. Our team will confirm here shortly 🙏$$,
   $$આભાર! {{area_text}} માં ડિલિવરી થાય છે કે નહીં તે અમે તપાસીએ છીએ. અમારી ટીમ અહીં જ જણાવશે 🙏$$,
   $$Aabhar! {{area_text}} ma delivery thay chhe ke nahi te ame check karie chhie. Amari team ahi j janavshe 🙏$$, FALSE, 0),

  ('Product (we know the word)', 75, 'PRODUCT', ARRAY[]::text[], ARRAY[]::text[], 'ANY', 'REPLY',
   $${{product_info}}

Order in the Bakaloo app:
📱 Android: {{play_store_link}}
🍎 iPhone: {{app_store_link}}$$,
   $${{product_info}}

Bakaloo એપમાં ઓર્ડર કરો:
📱 Android: {{play_store_link}}
🍎 iPhone: {{app_store_link}}$$,
   $${{product_info}}

Bakaloo app ma order karo:
📱 Android: {{play_store_link}}
🍎 iPhone: {{app_store_link}}$$, FALSE, 0),

  ('Price (no item named)', 78, 'CONTAINS', ARRAY['price','prices','rate','rates','cost','how much','bhav','bhaav','kimat','kinmat','ભાવ','કિંમત','ભાવો','કેટલા'], ARRAY[]::text[], 'ANY', 'REPLY',
   $$Prices change with the market, so the exact price of every item is shown in the Bakaloo app 📱
Android: {{play_store_link}}
iPhone: {{app_store_link}}

Tell me the item you want (for example tomato or lemon) and I'll check it for you.$$,
   $$ભાવ બજાર પ્રમાણે બદલાતા રહે છે, એટલે દરેક વસ્તુનો ચોક્કસ ભાવ Bakaloo એપમાં જોવા મળશે 📱
Android: {{play_store_link}}
iPhone: {{app_store_link}}

તમને કઈ વસ્તુ જોઈએ છે તે લખો (જેમ કે ટામેટા, લીંબુ), હું તપાસી આપીશ.$$,
   $$Bhav bajar pramane badalta rahe chhe, etle darek vastu no chokkas bhav Bakaloo app ma jova malshe 📱
Android: {{play_store_link}}
iPhone: {{app_store_link}}

Tamne kai vastu joiye chhe te lakho (jem ke tameta, libu), hu check kari aapish.$$, FALSE, 5),

  ('Where do you deliver?', 85, 'CONTAINS', ARRAY['serviceable','serviceability','service area','service areas','delivery area','delivery areas','do you deliver','where do you deliver','which areas','what areas','delivery available','delivery kya','delivery kyan','delivery kya kya','kya kya area','કયા વિસ્તાર','ક્યાં ડિલિવરી','ક્યાં ડિલિવરી થાય'], ARRAY[]::text[], 'ANY', 'REPLY',
   $$Hi {{customer_name}}, welcome to Bakaloo! 👋
We deliver fresh vegetables and groceries to your doorstep in {{served_areas}}.

Which area are you in? Please type your area name.$$,
   $$નમસ્તે {{customer_name}}, Bakaloo માં આપનું સ્વાગત છે! 👋
અમે {{served_areas}} માં તમારા ઘર સુધી તાજા શાકભાજી અને કરિયાણું પહોંચાડીએ છીએ.

તમારો વિસ્તાર કયો છે? કૃપા કરીને તમારા વિસ્તારનું નામ લખો.$$,
   $$Namaste {{customer_name}}, Bakaloo ma tamaru swagat chhe! 👋
Ame {{served_areas}} ma tamara ghar sudhi taaja shakbhaji ane grocery pahonchadie chhie.

Tamaro area kyo chhe? Krupa kari ne tamara area nu naam lakho.$$, TRUE, 0),

  ('How to order', 90, 'CONTAINS', ARRAY['how to order','how can i order','how do i order','how can we order','how to place order','order kevi rite','kevi rite order','order karvo','order karvu','order kari','ઓર્ડર કેવી રીતે','ઓર્ડર કેમ'], ARRAY[]::text[], 'ANY', 'REPLY',
   $$Ordering is easy! 😊
1️⃣ Download the Bakaloo app
📱 Android: {{play_store_link}}
🍎 iPhone: {{app_store_link}}
2️⃣ Choose your area and add items to the cart
3️⃣ Place your order

We deliver in {{served_areas}}. Which area are you in? Please type your area name and I'll confirm.$$,
   $$ઓર્ડર કરવો ખૂબ સરળ છે! 😊
1️⃣ Bakaloo એપ ડાઉનલોડ કરો
📱 Android: {{play_store_link}}
🍎 iPhone: {{app_store_link}}
2️⃣ તમારો વિસ્તાર પસંદ કરો અને વસ્તુઓ કાર્ટમાં ઉમેરો
3️⃣ ઓર્ડર કરો

અમે {{served_areas}} માં ડિલિવરી કરીએ છીએ. તમારો વિસ્તાર કયો છે? નામ લખશો તો હું ચકાસી આપું.$$,
   $$Order karvo khub saral chhe! 😊
1️⃣ Bakaloo app download karo
📱 Android: {{play_store_link}}
🍎 iPhone: {{app_store_link}}
2️⃣ Tamaro area select karo ane items cart ma add karo
3️⃣ Order karo

Ame {{served_areas}} ma delivery karie chhie. Tamaro area kyo chhe? Naam lakho to hu check kari aapu.$$, TRUE, 0),

  ('Help', 97, 'CONTAINS', ARRAY['help','menu','options','madad','મદદ'], ARRAY[]::text[], 'ANY', 'REPLY',
   $$I can help you with:
• Where we deliver
• How to order
• Prices of vegetables and groceries
• Order status
• Payment or refund

Just type your question, or your area name. To talk to our team, type 'agent'.$$,
   $$હું આમાં મદદ કરી શકું:
• અમે ક્યાં ડિલિવરી કરીએ છીએ
• ઓર્ડર કેવી રીતે કરવો
• શાકભાજી અને કરિયાણાના ભાવ
• ઓર્ડર સ્ટેટસ
• પેમેન્ટ અથવા રિફંડ

તમારો સવાલ અથવા તમારા વિસ્તારનું નામ લખો. અમારી ટીમ સાથે વાત કરવા 'agent' લખો.$$,
   $$Hu aama madad kari shaku:
• Ame kya delivery karie chhie
• Order kevi rite karvo
• Shakbhaji ane grocery na bhav
• Order status
• Payment athva refund

Tamaro sawal athva tamara area nu naam lakho. Amari team sathe vaat karva 'agent' lakho.$$, FALSE, 10),

  ('Greeting – ask area', 100, 'EXACT', ARRAY['hi','hii','hiii','hello','hey','hola','namaste','namaskar','good morning','good afternoon','good evening','kem cho','kem chho','jai shree krishna','jay shree krishna','jsk','hy','hlo','helo','હાય','હેલો','નમસ્તે','નમસ્કાર','કેમ છો','જય શ્રી કૃષ્ણ'], ARRAY[]::text[], 'ANY', 'REPLY',
   $$Hi {{customer_name}}, welcome to Bakaloo! 👋
We deliver fresh vegetables and groceries to your doorstep in {{served_areas}}.

Which area are you in? Please type your area name.$$,
   $$નમસ્તે {{customer_name}}, Bakaloo માં આપનું સ્વાગત છે! 👋
અમે {{served_areas}} માં તમારા ઘર સુધી તાજા શાકભાજી અને કરિયાણું પહોંચાડીએ છીએ.

તમારો વિસ્તાર કયો છે? કૃપા કરીને તમારા વિસ્તારનું નામ લખો.$$,
   $$Namaste {{customer_name}}, Bakaloo ma tamaru swagat chhe! 👋
Ame {{served_areas}} ma tamara ghar sudhi taaja shakbhaji ane grocery pahonchadie chhie.

Tamaro area kyo chhe? Krupa kari ne tamara area nu naam lakho.$$, TRUE, 360)
) AS v(name, position, match_type, keywords, exact_keywords, when_hours, action, reply_text, reply_text_gu, reply_text_gl, asks_area, cooldown_minutes)
WHERE NOT EXISTS (SELECT 1 FROM wa_bot_rules r WHERE r.name = v.name);
