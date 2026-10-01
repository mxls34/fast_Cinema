# fast_Cinema

A website that shows **Major Cineplex** and **SF Cinema** side by side. You pick a movie, then a cinema, a showtime and seats, and receive an e-coupon by email.

Database: Supabase project **CinemaTheater** (`jjuvwfbzmpkwzjknhdwu`, ap-northeast-1).

## What is in this repo

| Folder | What it is | Status |
|---|---|---|
| `supabase/migrations/` | Tables from the "DataBase Schema" slide, plus the read/booking functions (RPCs) and cron jobs | applied to Supabase |
| `supabase/functions/scrape-cinemas/` | **Data-collection API.** Scrapes majorcineplex.com and receives SF data from the collector | deployed, runs every 6 h |
| `supabase/functions/send-ticket/` | Emails the e-coupon after a booking (needs `RESEND_API_KEY` + `TICKET_FROM` secrets) | deployed |
| `collector/` | Runs on your computer: the SF Cinema browser collector (`npm run sf`), and `npm run major` to run the Major scrape now | working |
| `web/index.html` | **Home page**: all movies, a Major view, an SF view, and search | done |
| `web/report.html` | **Monitoring report**: opens when you **hold the Home button for 1 minute** | done |

## How the data gets in

```
majorcineplex.com ──(server fetch every 6 h, pg_cron)──► scrape-cinemas ──► movies / theaters / screens / showtimes
sfcinema.com ──(Chrome on your PC, Playwright)──► collector ──POST action=ingest──┘
```

- **Major Cineplex** is scraped on the server: the `/movie` page, then `booking2/get_showtime` for each movie and day. This is automatic.
- **SF Cinema** is behind a Cloudflare "Just a moment…" challenge. Every server gets HTTP 403, including Supabase, GitHub and cloud machines, so SF has to be collected from a real browser on your own computer.
- Movies are merged by **title**. The same film from both chains becomes one row with `has_major` and `has_sf` flags. If SF uses a different title spelling, the film shows up twice.

### Run the collector

```bash
cd collector
npm install
cp .env.example .env      # put the token in INGEST_TOKEN (SQL: select value from app_config where key='ingest_token')
npm run major             # scrape Major now (it also runs by itself every 6 hours)
npm run sf:discover       # FIRST TIME: opens Chrome on sfcinema.com and saves what the site loads into collector/out/
npm run sf:dry            # parse and print what would be saved
npm run sf                # parse and save SF to Supabase
npm test                  # parser unit tests
```

> **How SF is read** (from real captures, Oct 2026): `ticket/data/content` lists the movies, `ticket/data/branch` the 68 branches,
> and opening `/th/showtime/{movie id}` loads `ticket/data/session?contentId=…` with every showtime of that movie. The collector keeps
> the next 3 days (`--days=7` for more), pauses between movies and retries the ones SF did not answer. If SF changes its site and the
> numbers drop to 0, run `npm run sf:discover` and share the `out/sf-discovery-*` folder.

## Web app

These are static files with no build step. They need to be served over http, because ES modules don't load from `file://`:

```bash
cd web && python3 -m http.server 8000     # open http://localhost:8000
```

- **Home**: the three screens from the mockup. **Home** shows everything, **Major** is red and **SF** is blue. The dots under a poster show which chains have it.
- **Hidden report**: press and **hold Home for 60 s**. A gold ring fills up after 2 s, and at 60 s the page opens `report.html`. The report refreshes every minute and shows:
  - Health per source: ✓ ok, ! needs a look, or ✕ problem, with the command that fixes it. Major is expected every 6 h. SF is ok if it is under 24 h old.
  - Totals: movies showing, theaters, real bookings and revenue.
  - Showtimes stored for the next 7 days, per chain.
  - Monthly viewers (seats booked).
  - The last 20 scrape runs with their errors.
- The report is only *hidden*, not protected. Anyone who knows `report.html` can open it. It shows counts and scrape logs only, no customer data.

## Booking flow (all 6 features from the slide)

| # | Feature | Page | Uses |
|---|---|---|---|
| 1 | Which chains show a movie | `movie.html?id=` (from a Home card) | `now_showing()` → Major / SF buttons |
| 2 | Showtimes per cinema | `showtime.html?id=&brand=` date strip, search by branch / region | `movie_dates`, `movie_showtimes` |
| 3 | Free seats | `seat.html?showtime=` rows J–A, booked seats greyed, up to 10 seats | `get_seat_map` |
| 4 | Email for the e-coupon | `email.html` email + OTP code (or the link in the email) | Supabase Auth `signInWithOtp` / `verifyOtp` |
| 5 | Credit card / QR code | `pay.html` (simulated, no card number, no money moves) | `create_booking` (seats + payment in one transaction) |
| 6 | "จองสำเร็จ" + email | `done.html?token=` ticket code + QR | `booking_details`, edge function `send-ticket` |

In the Major or SF view of Home, a movie card goes straight to that chain's showtimes.

### Supabase settings the booking flow needs (Dashboard → Authentication)

1. **Email OTP code**: *Email Templates* → **Magic Link** and **Confirm signup**: add `{{ .Token }}` to the body,
   e.g. `<p>รหัส OTP ของคุณ: <b>{{ .Token }}</b></p>`. Without it the email has only a link (the link also works).
2. **Redirect URLs**: *URL Configuration* → add `http://localhost:3000/**` (and your real site URL when deployed),
   so the link in the email comes back to `email.html`.
3. **Who can receive email**: Supabase's built-in email only sends to members of your Supabase team and only a few
   per hour. For real users set up *SMTP Settings* (for example Resend, Brevo or Gmail SMTP).
4. **Ticket email** (feature 6): set the edge-function secrets `RESEND_API_KEY` and `TICKET_FROM`
   (*Edge Functions → Secrets*). Without them the ticket is shown on screen only.
