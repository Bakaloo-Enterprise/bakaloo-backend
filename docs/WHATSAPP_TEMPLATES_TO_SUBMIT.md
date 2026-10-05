# Bakaloo WhatsApp templates — ready to submit to Meta

All names are lowercase_with_underscores (Meta rule). Variables are named, none at the start or end of a message.
Language: English (en). Add Hindi copies later if wanted.

## UTILITY (transactional — usually approved within minutes)

### 1. `welcome_how_can_we_help`  · purpose: Custom
**Body**
Hi {{customer_name}}, this is Bakaloo, your neighbourhood grocery delivery. We are here to help with your orders, delivery or anything else. Just reply to this message and our team will assist you.
**Footer:** Bakaloo – fresh groceries, fast delivery
Example: customer_name = Rahul

### 2. `order_confirmed`  · purpose: Order Placed
**Body**
Hi {{customer_name}}, thank you for ordering with Bakaloo! Your order {{order_number}} of Rs {{order_total}} is confirmed and we are getting it ready. We will keep you updated on every step.
**Footer:** Bakaloo – fresh groceries, fast delivery
Examples: Rahul / BK10234 / 540

### 3. `order_out_for_delivery`  · purpose: Out for Delivery
**Body**
Hi {{customer_name}}, good news! Your Bakaloo order {{order_number}} is out for delivery and will reach you in about {{eta_minutes}} minutes. Please keep your phone handy for our delivery partner.
**Footer:** Bakaloo – fresh groceries, fast delivery
Examples: Rahul / BK10234 / 20

### 4. `order_delivered`  · purpose: Delivered
**Body**
Hi {{customer_name}}, your Bakaloo order {{order_number}} has been delivered. We hope you enjoy it! If anything is missing or not right, just reply here and we will fix it quickly.
**Footer:** Thank you for shopping with Bakaloo
Examples: Rahul / BK10234

### 5. `payment_pending_reminder`  · purpose: Payment Reminder
**Body**
Hi {{customer_name}}, the payment of Rs {{order_total}} for your Bakaloo order {{order_number}} is still pending. Please complete it in the Bakaloo app so we can process your order. Reply here if you need help.
**Footer:** Bakaloo – fresh groceries, fast delivery
Examples: Rahul / 540 / BK10234

## MARKETING (promotions — only to customers who opted in; needs approval review, can take longer)

### 6. `cart_reminder`  · purpose: Abandoned Cart
**Body**
Hi {{customer_name}}, you left some items in your Bakaloo cart. They are still waiting for you! Open the app to complete your order and get it delivered fresh to your door.
**Footer:** Reply STOP to opt out
Examples: Rahul

### 7. `we_miss_you`  · purpose: Inactive Customer
**Body**
Hi {{customer_name}}, it has been a while since your last Bakaloo order and we miss you! Fresh fruits, vegetables and daily essentials are ready for delivery. Open the app and order today.
**Footer:** Reply STOP to opt out
Examples: Rahul

### 8. `coupon_offer`  · purpose: Coupon
**Body**
Hi {{customer_name}}, here is a treat from Bakaloo! Use code {{coupon_code}} to save on your next order. Valid till {{expiry_date}}. Open the app and shop now.
**Footer:** Reply STOP to opt out
Examples: Rahul / SAVE50 / 31 Oct

## Notes
- Meta approval is not instant for marketing. Utility ones are normally minutes to a few hours.
- A template name stays reserved for 30 days after deletion, so double-check wording before submitting.
- Marketing messages cost more per message than utility. Enter Meta's India rates under Analytics → Cost & prices.
