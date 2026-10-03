# Pilates w Basma: class booking website

A booking website for a Pilates and yoga instructor. Clients see the weekly timetable, book a spot and pay online. When a class is full they can join a waiting list.

## Features

- **Timetable**: weekly classes are set in `schedule.json`. Dates are created automatically for the next few weeks, with live "spots left" counts.
- **Online booking and payment**: clients pay through Stripe Checkout (cards, Apple Pay and Google Pay). Their seat is held for 35 minutes while they pay.
- **Waiting list**: when a class is full, clients can join the waiting list. If a spot opens up (a cancellation, an unpaid hold that expires, or a capacity increase), the first person on the list gets an email with a link to claim it. The spot is held for them for `WAITLIST_OFFER_HOURS`. If they don't claim it in time, it moves to the next person automatically.
- **Self-service cancellation**: every confirmation email has a link to view or cancel the booking. Clients can cancel up to `CANCELLATION_HOURS` before class and get an automatic refund.
- **Instructor dashboard** (`/admin`, password protected):
  - see bookings, client notes and the waiting list for each class
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

Edit **`schedule.json`**:

```json
{
  "key": "mon-1800-mat-pilates",   // unique id, never reuse for a different time
  "title": "Mat Pilates",
  "day": "Monday",
  "time": "18:00",                 // 24h, studio timezone
  "durationMinutes": 60,
  "capacity": 10,
  "price": 10,                     // in the main currency unit
  "description": "Full-body mat Pilates for all levels."
}
```

Also set `studio.timezone` (for example `Asia/Dubai` or `Europe/London`), `studio.currency` (for example `usd`, `aed` or `gbp`), the address, the contact details and the text. Restart the server after editing. Dates that already exist are not changed, so cancel those from the dashboard if needed. If you change a class's time, give it a new `key`.

> ⚠️ The class times currently in `schedule.json` are **placeholders**. Replace them with the real times from the current Google Form.

## Taking real payments (Stripe)

1. Create a Stripe account at https://dashboard.stripe.com and copy the **secret key** into `STRIPE_SECRET_KEY`.
2. Add a webhook endpoint: **Developers → Webhooks → Add endpoint**.
   - URL: `https://YOUR-DOMAIN/api/stripe/webhook`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`
   - Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Set `BASE_URL` to the public URL of the site.

Test first with Stripe's `sk_test_…` keys and card `4242 4242 4242 4242`.

Stripe is not available in every country. All the gateway code lives in `src/payments.js` behind a small interface (`createCheckout`, `getCheckout`, `expireCheckout`, `refund`), so you can swap in another provider without touching the booking logic.

## Sending emails

Fill in the `SMTP_*` settings. Most email providers work: Gmail with an app password, Zoho, Brevo, Mailgun and so on. Set `ADMIN_NOTIFY_EMAIL` to get an email for every new booking.

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
