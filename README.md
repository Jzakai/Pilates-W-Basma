# Pilates w Basma: class booking website

A booking website for Basma's women-only Pilates classes at KAUST (Harbor Fitness Studio). Clients see the timetable, book a spot and pay online. When a class is full they can join a waiting list.

## Features

- **Timetable**: weekly classes are set in `schedule.json`. Dates are created automatically for the next few weeks, with live "spots left" counts.
- **Online booking and payment**: clients enter their name, email, phone/WhatsApp, whether it's their first Pilates class, and any injuries or comments. They then pay through **Moyasar** (mada, Visa/Mastercard, Apple Pay, STC Pay). Their seat is held for 35 minutes while they pay.
- **Bank transfer / STC Pay option** (can be switched off): the client reserves a spot and gets the bank details. The spot is held for `TRANSFER_HOLD_HOURS`, but never past the start of class. Basma clicks **Mark paid** in the dashboard when the money arrives, and the client gets a confirmation.
- **Waiting list**: when a class is full, clients can join the waiting list. If a spot opens up (a cancellation, an unpaid hold that expires, or a capacity increase), the first person on the list gets an email with a link to claim it. The spot is held for them for `WAITLIST_OFFER_HOURS`. If they don't claim it in time, it moves to the next person automatically.
- **Self-service cancellation**: every confirmation email has a link to view or cancel the booking. Clients can cancel up to `CANCELLATION_HOURS` before class and get an automatic refund.
- **Instructor dashboard** (`/admin`, password protected):
  - see bookings, phone numbers, "first time" flags, injury notes and the waiting list for each class
  - mark bank transfers as paid
  - cancel a booking, with or without a refund
  - change a class's capacity
  - cancel a whole class (everyone is refunded and emailed)
  - add cash or bank-transfer clients by hand
- **Emails** for confirmations, waiting-list offers and cancellations, plus an optional "new booking" email to the instructor.

## Quick start

Requires **Node.js 22.13 or newer**. It uses Node's built-in SQLite, so you don't need a separate database.

```bash
npm install
cp .env.example .env     # then edit .env (at least ADMIN_PASSWORD)
npm start                # http://localhost:3000
```

If `STRIPE_SECRET_KEY` is not set, the site runs in **demo mode**. A banner shows at the top and payments are simulated, so you can try the whole flow. If SMTP is not set, emails are printed to the console instead of being sent.

Run the tests with `npm test`.

## Setting the class timetable

The timetable is set up as Sunday 7:15–8:15 pm and Tuesday 7–8 pm, 30 SAR, 10 spots per class.

Edit **`schedule.json`**:

```json
{
  "key": "sun-1915-pilates",   // unique id, never reuse for a different time
  "title": "Pilates",
  "day": "Sunday",
  "time": "19:15",             // 24h, Riyadh time
  "durationMinutes": 60,
  "capacity": 10,
  "price": 30,                 // SAR
  "description": "Mat Pilates for all levels."
}
```

The `studio` section holds the text, location, timezone (`Asia/Riyadh`), currency (`sar`) and the bank transfer details shown to clients (`bankTransfer.instructions`). Restart the server after editing. Dates that already exist are not changed, so cancel those from the dashboard if needed. If you change a class's time, give it a new `key`.

> ⚠️ The IBAN and STC Pay number in `bankTransfer.instructions` are **placeholders**. Put the real ones in before going live, or set `bankTransfer.enabled` to `false` to offer online payment only. The 10-spot capacity is also a guess.

## Taking real payments (Moyasar)

Stripe does not support businesses in Saudi Arabia, so the site uses [Moyasar](https://moyasar.com), a Saudi gateway licensed by SAMA. It supports mada, Visa/Mastercard, Apple Pay and STC Pay. Clients pay on Moyasar's hosted invoice page.

1. Sign up at https://dashboard.moyasar.com. Moyasar accepts freelancers with a Freelance Document as well as companies with a CR.
2. Copy the **secret key** into `MOYASAR_SECRET_KEY`. Start with the test key `sk_test_…`.
3. In **Settings → Webhooks**, add `https://YOUR-DOMAIN/api/moyasar/webhook`.
   - Choose a secret token and put the same value in `MOYASAR_WEBHOOK_SECRET`.
   - Enable the payment paid event.
4. Set `BASE_URL` to the public URL of the site.

The site never trusts the webhook body by itself. It always re-checks the invoice with Moyasar's API before confirming a booking. It also re-checks when the client comes back to the site after paying.

> The Moyasar integration was written against Moyasar's Invoices API but has **not yet been run against a live Moyasar account**. Do a full test booking, cancellation and refund with test keys before taking real payments.

### Stripe (other countries)

If you run this outside Saudi Arabia, Stripe is also supported:

1. Create a Stripe account at https://dashboard.stripe.com and copy the **secret key** into `STRIPE_SECRET_KEY`.
2. Add a webhook endpoint: **Developers → Webhooks → Add endpoint**.
   - URL: `https://YOUR-DOMAIN/api/stripe/webhook`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`
   - Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Set `BASE_URL` to the public URL of the site.

Test first with Stripe's `sk_test_…` keys and card `4242 4242 4242 4242`.

All the gateway code lives in `src/payments.js` behind a small interface (`createCheckout`, `getCheckout`, `expireCheckout`, `refund`), so you can swap in another provider without touching the booking logic.

## Sending emails

Fill in the `SMTP_*` settings. Most email providers work: Gmail with an app password, Zoho, Brevo, Mailgun and so on. Set `ADMIN_NOTIFY_EMAIL` to get an email for every new booking.

## Free test deploy (Render)

`render.yaml` sets the site up on Render's free plan, in demo mode with no keys needed:

1. Sign up at https://render.com with GitHub.
2. Go to **New → Blueprint** and pick this repository and branch.
3. Enter a dashboard password when Render asks for `ADMIN_PASSWORD`, then click **Apply**.

The free plan sleeps after about 15 minutes idle, so the first visit afterwards takes up to a minute. Its disk is wiped on every restart or deploy, so it is only for testing. Emails appear under the service's **Logs** tab.

## Deploying

The app is a single Node process with a SQLite file, so any host that runs Node and keeps a persistent disk will work. Examples are Render, Railway, Fly.io or a small VPS.

- Set the environment variables from `.env.example`.
- Point `DATABASE_PATH` at a persistent volume.
- Serve it over HTTPS. The dashboard uses HTTP basic authentication with username `admin` and `ADMIN_PASSWORD`.

## How it works

| File | Purpose |
| --- | --- |
| `schedule.json` | Studio details and the weekly timetable |
| `src/bookings.js` | Booking, payment-hold, waiting-list and cancellation rules |
| `src/payments.js` | Stripe and demo payment adapters |
| `src/app.js` | HTTP routes (public API, Stripe webhook, admin API) |
| `src/server.js` | Starts the server and the background job that runs every minute (expires holds and offers) |
| `public/` | Website pages: timetable, booking status, waiting-list claim, dashboard |

A class's spots are taken by:
- confirmed bookings
- unpaid bookings still inside their hold
- waiting-list offers that haven't expired yet

So a freed spot is never given to the public while someone on the waiting list has an open offer for it.
