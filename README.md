# Pilates w Basma: class booking website

A booking website for Basma's women-only Pilates classes at KAUST (Harbor Fitness Studio). Clients create an account, book one or several classes, pay by bank transfer or STC Pay by uploading the receipt, and join a waiting list when a class is full. Basma checks receipts and manages the schedule from her dashboard.

## Features

### For clients
- **Account:** sign up with email, name, phone/WhatsApp, injuries and activity level, then sign in. Password reset works by email.
- **Book several classes at once:** select classes on the timetable and book them together. Online booking closes `BOOKING_CUTOFF_HOURS` (48) before class.
- **Pay by receipt:** pay straight away or later from **Pending payments**:
  - Pay for one class or a batch with a single transfer, then upload the receipt (photo or PDF).
  - Account credit is used first if you tick it.
  - A reminder email goes out `PAYMENT_REMINDER_HOURS` (48) before class.
  - Unpaid spots are released `PAYMENT_DEADLINE_HOURS` (24) before class.
- **Cancel online:** allowed until `CANCELLATION_HOURS` (12) before class. A paid class comes back as **credit** on the account.
- **Waiting list:** when a spot frees up, the next client is emailed and can claim it from her account within `WAITLIST_OFFER_HOURS` (12).
- **Notifications:** emails for confirmations (with a calendar invite), reminders, waitlist offers and cancellations. There's also an **Add to calendar** button on each booking.

### For the instructor (`/admin`)
- **Receipts:** see each uploaded receipt next to the classes it pays for.
  - **Approve** confirms the bookings.
  - **Reject** (with a reason) emails the client and puts the classes back into her pending payments, so she can upload a correct receipt before the deadline.
- **Classes:** per class, see who is booked, their payment status, activity level and injuries, plus the waiting list. You can also:
  - change capacity
  - cancel a client's booking (optionally giving credit)
  - add someone who paid in cash
  - cancel the whole class
- **Cancelling a class:** everyone who already paid gets the fee as credit. Receipts still being checked turn into credit when approved.
- **Class schedule:** add and edit weekly classes (day, time, length, spots, price), switch them off, or add one-off classes on a single date.

## Quick start

Requires **Node.js 22.13 or newer**. It uses Node's built-in SQLite, so you don't need a separate database.

```bash
npm install
cp .env.example .env     # then edit .env (at least ADMIN_PASSWORD)
npm start                # http://localhost:3000
```

If SMTP is not set, emails are printed to the console. Run the tests with `npm test`.

## Studio details and first timetable

`schedule.json` holds:
- the studio text, location and timezone (`Asia/Riyadh`)
- the bank / STC Pay details shown when paying (`paymentInstructions`)
- the starting weekly classes

The weekly classes are copied into the database the first time the site starts. After that, manage classes from the dashboard's **Class schedule** tab.

> ⚠️ The IBAN and STC Pay number in `paymentInstructions` are **placeholders**. Put the real ones in before going live.

## Sending emails

Fill in the `SMTP_*` settings. Most email providers work: Gmail with an app password, Zoho, Brevo, Mailgun and so on. Email is needed in production for confirmations, payment reminders and password resets. Set `ADMIN_NOTIFY_EMAIL` to be told about new bookings and receipts to check.

## Free test deploy (Render)

`render.yaml` sets the site up on Render's free plan:

1. Sign up at https://render.com with GitHub.
2. Go to **New → Blueprint** and pick this repository.
3. Enter a dashboard password when Render asks for `ADMIN_PASSWORD`, then click **Apply**.

The free plan sleeps after about 15 minutes idle. Its disk is wiped on every restart or deploy, which deletes **accounts, bookings and uploaded receipts**, so it is only for testing. Emails appear under the service's **Logs** tab.

## Deploying for real

The app is a single Node process with a SQLite file and a receipts folder, so it needs a host with a persistent disk. On Render that's the Starter plan plus a disk:

- Set `DATABASE_PATH` to the disk, e.g. `/var/data/bookings.db`. Receipts are saved next to it in `/var/data/receipts`.
- Set the other variables from `.env.example`.
- Serve it over HTTPS. Render does this automatically. Client sign-ins use secure cookies over HTTPS, and the dashboard uses HTTP basic authentication with username `admin` and `ADMIN_PASSWORD`.

## How it works

| File | Purpose |
| --- | --- |
| `schedule.json` | Studio details, payment instructions, starting timetable |
| `src/accounts.js` | Sign up, sign in, sessions, password reset (scrypt-hashed passwords) |
| `src/bookings.js` | Booking, receipt payments, credits, waiting list, cancellation and schedule rules |
| `src/app.js` | HTTP routes, receipt uploads, admin API |
| `src/server.js` | Starts the server and the background jobs (every minute: release unpaid spots, send reminders, pass on lapsed waitlist offers) |
| `public/` | Timetable, sign in / sign up, My account, dashboard |
| `docs/` | Use case diagram (PlantUML) |

**Booking statuses:** `awaiting_payment` → (receipt uploaded) `payment_review` → (approved) `confirmed`. A booking can be `cancelled` at any point.

**What holds a spot:** every booking that isn't cancelled, plus waitlist offers that haven't expired. A freed spot is never given to the public while someone on the waiting list has an open offer for it.

Earlier versions supported online card payments through Moyasar and Stripe. That code was removed for now, but it is still in the git history.
