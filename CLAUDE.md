# ElkPro Cut — booking web app

Appointment booking site for ElkPro Cut (a barber/services shop in Seoul).
Create React App (react-scripts 5) + React 18 + Firebase (Auth + Firestore),
deployed to Netlify at https://elkpro.netlify.app.

The GitHub repo was renamed `Booking-Web-App` -> `elkpro-booking-web-app` in
September 2026. Old links still redirect. The `name` field in `package.json` is
`appointments` and its `repository.url` still points at the old `hsanshine/`
fork path — neither is load-bearing.

## Running it locally

```bash
yarn install
yarn start          # or: npm start
```

**A blank white page means missing env vars, not a build failure.**
`src/database/firebase-config.js` calls `getAuth()` at module load; with an
undefined `apiKey` it throws before React mounts, so `#root` stays empty and the
console shows nothing useful. Create a `.env` (gitignored) with all seven:

```
REACT_APP_API_KEY, REACT_APP_AUTH_DOMAIN, REACT_APP_PROJECT_ID,
REACT_APP_STORAGE_BUCKET, REACT_APP_MESSAGING_SENDER_ID,
REACT_APP_APPID, REACT_APP_MEASUREMENT_ID
```

The real values are set as environment variables on the Netlify site
(Project configuration -> Environment variables). Placeholder values render the
home page fine but break `/new-booking`: Firestore returns `permission-denied`,
`settings` comes back `null`, and `TimeSelector` throws destructuring
`startTime`. There is no null guard and no error boundary — worth fixing.

## Use yarn, not npm

Netlify builds with `yarn build`, and `yarn.lock` is the authoritative lockfile.

`npm ci` **fails** — `package-lock.json` is out of sync with `package.json` and
ERESOLVEs on `react-timekeeper`'s React 18 peer range. If you must use npm,
`npm install --legacy-peer-deps` works. Both lockfiles are committed, which makes
Netlify emit a mixed-lockfile warning; yarn wins.

## Node version

Pinned to **22** via `.nvmrc`. Do not drop below 18.

Netlify's dashboard still shows `16.x` under Dependency management — that
setting is stale and `.nvmrc` overrides it. Node 16 was the default when the
site was created in 2022.

This matters: production deploys silently broke between March and August 2026
with no code change. `node-releases`, a floating transitive dep of
`browserslist`, raised its engine requirement to `>=18`, and every build died at
the dependency-installation stage on Node 16:

```
error node-releases@2.0.54: The engine "node" is incompatible with this
module. Expected version ">=18". Got "16.20.2"
```

`yarn.lock` was refreshed at the same time so transitive deps are pinned rather
than re-resolved on every build, which is what let that break happen silently.
Regenerating the lockfile again will re-float them — do it deliberately.

## Deploys

Auto-publish is on: any push to `main` deploys to production. PRs get Deploy
Previews. Build command `yarn build`, publish directory `build`, production
branch `main`.

When a deploy seems missing, check the deploy log before assuming the hook is
broken — the failure mode above looks exactly like "the webhook stopped firing"
from the outside. GitHub shows no commit statuses or check runs for this repo,
so GitHub is not a reliable signal for deploy health; read Netlify directly.

## Layout

- `src/components/` — UI, one directory per component (`BookingMenu`,
  `TimeSelector`, `ClockPicker`, `MapDirections`, `NavBar`, ...)
- `src/pages/` — routed pages (`NewBooking`, `SlotSettingsPage`, ...)
- `src/database/firebase-config.js` — Firebase init, exports `auth` and `db`
- `src/store/auth-context.js` — auth context provider
- Routing is `react-router-dom` v5 (`Switch`/`Route`, not v6 `Routes`).
