# ElkPro Cut — booking web app

Appointment booking site for ElkPro Cut (a barber shop in Yongsan, Seoul).
Create React App (react-scripts 5) + React 18, deployed to Netlify at
https://elkpro.netlify.app.

Data lives in **Neon Postgres**, reached through a Netlify Function.
**Auth is still Firebase** — that migration has not happened yet. See below,
because the split matters.

The GitHub repo was renamed `Booking-Web-App` -> `elkpro-booking-web-app` in
September 2026. Old links still redirect.

## Running it locally

```bash
yarn install
netlify dev          # http://localhost:8888
```

**Use `netlify dev`, not `npm start`.** Plain CRA does not run Netlify
Functions, so `/.netlify/functions/api` returns 404 and every page that loads
data breaks. `npm start` is only useful for pure-styling work.

`.env` (gitignored) needs the seven `REACT_APP_*` Firebase values plus
`DATABASE_URL`. Only `REACT_APP_*` reaches the browser — CRA inlines that
prefix and nothing else, which is exactly why `DATABASE_URL` must never be
renamed to carry it.

Without the Firebase values the app renders a **blank page**: `getAuth()`
throws at module load in `src/database/firebase-config.js`, React never
mounts, and the console shows nothing useful. Same values are set on the
Netlify site.

## Architecture

```
browser ──▶ /.netlify/functions/api ──▶ Neon Postgres     (all data)
        └─▶ Firebase Auth                                 (sign-in only)
```

- `netlify/functions/api.js` — one action-routed function, ~12 operations.
- `src/http/serverInterface.ts` — the only module that talks to the API.
  Components never call it directly; they go through the pages.
- `db/schema.sql`, `db/load.py` — schema and the Firestore migration loader.

A browser cannot hold a Postgres credential, which is the point: `DATABASE_URL`
stays server-side. The previous design had the browser talk to Firestore
directly with rules that allowed **anonymous read, write and delete of every
booking**. Do not reintroduce direct-from-browser data access.

### Slots are minute-granular

2,576 migrated rows carry sub-second timestamps, so never compare instants with
`=`. Every slot comparison truncates:
`date_trunc('minute', starts_at AT TIME ZONE 'UTC')`. The UTC pin is required —
`date_trunc` on `timestamptz` is only STABLE and cannot be indexed otherwise.

`bookings_one_confirmed_per_minute` is the real guard against double-booking.
Six historical collisions (2022–2023) were resolved by demoting the later row
to `cancelled` before it could be created.

There is no `slots` table. Availability is derived: confirmed bookings plus
`blocked_slots`. The old Firestore `slots` collection duplicated bookings and
had already drifted (276 bookings with no slot row, 34 slots with no booking).

### Settings times are strings, not SQL times

`getSettings` returns `"1:00 pm"`, not `"13:00:00"`. `src/utils/helpers.js`
parses them with `moment(start, "h:mma")` to build the slot grid, so the 24h
form silently produces a wrong grid. The API converts with
`to_char(start_time, 'FMHH12:MI am')`. Do not "simplify" this.

## Use yarn

Netlify runs `yarn build`. `yarn.lock` is authoritative and `package-lock.json`
is gitignored — do not commit one, it triggers Netlify's mixed-lockfile warning.

## Node version

Pinned to **22** in `.nvmrc` and in Netlify's dependency settings, which govern
builds *and* the functions runtime. Do not drop below 18.

Production deploys silently broke for six months on Node 16: `node-releases`, a
floating transitive dep of `browserslist`, raised its engine requirement to
`>=18` and every build died during dependency installation. `yarn.lock` was
refreshed at the same time so transitive deps are pinned rather than
re-resolved each build.

## Known gaps

- **Firebase Auth is unmanageable.** Nobody has console access to the
  `appointments-9fa9d` project. Three admin **Firebase UIDs** are hardcoded in
  `netlify/functions/api.js` and `src/store/auth-context.js`; admins cannot be
  added or removed. Replacing auth (Neon Auth / Managed Better Auth) would make
  admin a column instead. Only ~890 of 2,944 bookings have a user attached.
- **Firestore still holds the old data** and is still anonymously readable and
  deletable. Nothing reads it any more. It should be purged.
- `TimeSelector` destructures `settings.startTime` with no null guard and there
  is no error boundary, so a failed settings fetch blanks the booking page.
- Guests book without logging in (69% of bookings), phone lookup is
  unauthenticated by design, and the daily-booking rule (`count > 1`) in
  practice permits two bookings per customer per day. All intentional.

## Deploys

Auto-publish from `main`; PRs get Deploy Previews. Build `yarn build`, publish
`build`. The Netlify CLI is installed — prefer `netlify` commands over the web
UI, whose React buttons often ignore programmatic clicks.

When a deploy seems missing, read Netlify's own log. GitHub shows no commit
statuses or check runs for this repo, so it is not a reliable signal.

## Layout

- `src/components/` — one directory per component
- `src/pages/` — routed pages (`NewBooking`, `SlotSettingsPage`, `Admin`, ...)
- `src/store/auth-context.js` — Firebase auth context
- `src/utils/helpers.js` — slot-grid generation, date/time combining
- Routing is `react-router-dom` v5 (`Switch`/`Route`, not v6 `Routes`)
