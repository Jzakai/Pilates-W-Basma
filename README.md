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

Requires **Node.js 22.13 or newer**. Locally it uses Node's built-in SQLite, so you don't need to set up a database to try it. In production it uses Postgres on Supabase (see below).

```bash
npm install
cp .env.example .env     # then edit .env (at least ADMIN_PASSWORD)
npm start                # http://localhost:3000
```

If SMTP is not set, emails are printed to the console. Run the tests with `npm test`. To also run them against Postgres, set `TEST_DATABASE_URL` to an **empty test database** (the tests wipe it).

## Studio details and first timetable

`schedule.json` holds:
- the studio text, location and timezone (`Asia/Riyadh`)
- the bank / STC Pay details shown when paying (`paymentInstructions`)
- the starting weekly classes

The weekly classes are copied into the database the first time the site starts. After that, manage classes from the dashboard's **Class schedule** tab.

> ⚠️ The IBAN and STC Pay number in `paymentInstructions` are **placeholders**. Put the real ones in before going live.

## Sending emails

Fill in the `SMTP_*` settings. Most email providers work: Gmail with an app password, Zoho, Brevo, Mailgun and so on. Email is needed in production for confirmations, payment reminders and password resets. Set `ADMIN_NOTIFY_EMAIL` to be told about new bookings and receipts to check.

## Database and receipts: Supabase

The site keeps its data in **Postgres** and receipt photos in **Storage** on [Supabase](https://supabase.com). Both have a free tier, and you can browse everything in Supabase's dashboard: clients, bookings, payments and credit in the **Table Editor**, and receipt files in **Storage**.

Without these settings the site falls back to a local SQLite file and a local receipts folder, which is what you want on your own computer.

1. Create a project at https://supabase.com (**New project**). Pick the region closest to KAUST and save the database password it asks for.
2. Click **Connect** at the top of the project. Under **Session pooler**, copy the connection string (it looks like `postgresql://postgres.abcd…:[YOUR-PASSWORD]@aws-0-….pooler.supabase.com:5432/postgres`) and put your database password in it. Use the session pooler, not the "direct connection": Render can't reach the direct address. If the password has symbols like `@` or `#`, either change it to letters and numbers or URL-encode them.
3. Go to **Project Settings → API Keys** and copy the **service_role** secret key. The project URL (`https://abcd….supabase.co`) is under **Project Settings → Data API**.
4. Add these environment variables to the host (on Render: the service → **Environment**), then save and redeploy:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the session pooler connection string from step 2 |
| `SUPABASE_URL` | the project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | the service_role key |

On first start the site creates its tables and a private `receipts` bucket. The start-up log says which database and receipt storage it is using.

**Keep the service_role key and the database password secret.** Only put them in the host's environment settings, never in the code or the repository. The tables have row level security switched on with no policies, so Supabase's public API cannot read them; only the server (which connects as the database owner) can.

You can look at data in the Table Editor at any time. Make changes through the dashboard at `/admin` rather than by editing rows by hand, because the site's rules (spots, credit, waitlist offers, emails) only run there.

Free Supabase projects are paused after a stretch of no activity (about a week at the time of writing). A site with regular bookings keeps it awake; if it does get paused, restore it from the Supabase dashboard.

## Deploying on Render

`render.yaml` sets the site up on Render:

1. Sign up at https://render.com with GitHub.
2. Go to **New → Blueprint** and pick this repository.
3. Enter values when Render asks for `ADMIN_PASSWORD`, `DATABASE_URL`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, then click **Apply**.

Already have the service? Add the three Supabase variables under **Environment** instead.

With Supabase connected, nothing is lost when Render restarts, so the free plan works for real bookings. It still sleeps after about 15 minutes without visitors, so the first visit after a quiet spell takes up to a minute to load, and payment reminders and releases of unpaid spots run when it wakes up rather than exactly on time. The Starter plan (always on) avoids both.

HTTPS is automatic on Render. Client sign-ins use secure cookies over HTTPS, and the dashboard uses HTTP basic authentication with username `admin` and `ADMIN_PASSWORD`. Emails appear under the service's **Logs** tab until SMTP is set up.

## How it works

| File | Purpose |
| --- | --- |
| `schedule.json` | Studio details, payment instructions, starting timetable |
| `src/db.js` | Database tables, Postgres (Supabase) or SQLite connection |
| `src/storage.js` | Receipt files: Supabase Storage or a local folder |
| `src/accounts.js` | Sign up, sign in, sessions, password reset (scrypt-hashed passwords) |
| `src/bookings.js` | Booking, receipt payments, credits, waiting list, cancellation and schedule rules |
| `src/app.js` | HTTP routes, receipt uploads, admin API |
| `src/server.js` | Starts the server and the background jobs (every minute: release unpaid spots, send reminders, pass on lapsed waitlist offers) |
| `public/` | Timetable, sign in / sign up, My account, dashboard |
| `docs/` | Use case diagram (PlantUML) |

**Booking statuses:** `awaiting_payment` → (receipt uploaded) `payment_review` → (approved) `confirmed`. A booking can be `cancelled` at any point.

**What holds a spot:** every booking that isn't cancelled, plus waitlist offers that haven't expired. A freed spot is never given to the public while someone on the waiting list has an open offer for it.

Earlier versions supported online card payments through Moyasar and Stripe. That code was removed for now, but it is still in the git history.
