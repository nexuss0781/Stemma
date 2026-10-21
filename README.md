# Stemma

A responsive, mobile-first wallet dashboard prototype with server-side Google and Fayda eSignet OpenID Connect sign-in flows. The dashboard remains a visual prototype: it does not connect to a bank, store wallet balances, or process financial data or transactions.

## Preview

Desktop:

![Stemma desktop preview](local-preview.png)

Mobile:

![Stemma mobile preview](mobile-preview.png)

Mobile sidebar:

![Stemma mobile sidebar preview](mobile-sidebar-preview.png)

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env
```

Generate a local session secret and put the value in `.env`:

```bash
openssl rand -base64 48
```

Run the application backend and frontend together (the server reads `.env` when present; environment variables can also be supplied by the deployment):

```bash
npm start
```

Open <http://localhost:3000>. `Skip` remains available as a guest path and does not create an authenticated session. Google and Fayda sign-in remain unavailable until their respective credentials are configured. The blank `.env.example` deliberately contains no client credentials or signing keys.

For UI-only preview without the backend, `python3 -m http.server 8000` still serves the static prototype; sign-in buttons explain that authentication needs the backend.

## Fayda eSignet configuration

Register Stemma as a relying party in the Fayda Partner Portal and use values issued for that specific environment. Do not use another application's demo client or private key. Configure these server-side environment variables (see `.env.example`):

- `FAYDA_ISSUER` — exact issuer for the selected sandbox or production environment. Discovery is derived as `{issuer}/.well-known/openid-configuration`, or can be set explicitly with `FAYDA_DISCOVERY_URL`.
- `FAYDA_CLIENT_ID` — Stemma's registered client ID.
- `FAYDA_CLIENT_PRIVATE_JWK_PATH` or `FAYDA_CLIENT_PRIVATE_JWK` — Stemma's registered RSA private JWK. Prefer a mounted secret file with mode `0600`; never commit it or expose it to the browser.
- `FAYDA_REDIRECT_URI` — exact callback URI registered for this client. Local development defaults to `http://localhost:3000/auth/fayda/callback`; production must use HTTPS.
- `SESSION_SECRET` — a unique random value of at least 32 bytes.
- `APP_ORIGIN` — public app origin; it must match the callback origin.

The initial scope is only `openid`. The integration intentionally sends no `claims`, requests no profile fields, and stores no Fayda tokens or returned profile data. `FAYDA_ACR_VALUES` and `FAYDA_UI_LOCALES` are optional and should remain unset unless Fayda confirms values for Stemma's registered client. The client assertion lifetime defaults to 60 seconds and can be set from 30–300 seconds with `FAYDA_ASSERTION_TTL_SECONDS`; confirm the accepted lifetime with Fayda.

The backend discovers the provider endpoints, enforces the configured issuer, and uses HTTPS endpoints. It implements authorization-code flow with per-attempt state, nonce, and S256 PKCE; server-side one-time transactions; private_key_jwt client authentication; RS256 ID-token and signed UserInfo verification; nonce and subject matching; session-ID rotation; HTTP-only, SameSite=Lax cookies; rate limits; and safe generic callback failures. Tokens, codes, assertions, provider error descriptions, and identity claims are not sent to browser storage or logged.

## Google sign-in configuration

Create an OAuth client of type **Web application** in Google Cloud Console. Add these production values to that client:

- Application home page: `https://stemma.wasmer.app`
- Authorized JavaScript origin: `https://stemma.wasmer.app`
- Authorized redirect URI: `https://stemma.wasmer.app/auth/google/callback`

The redirect URI must match exactly. For local development, you can also register `http://localhost:3000` as the origin and `http://localhost:3000/auth/google/callback` as a redirect URI. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as server-side environment variables, and set `GOOGLE_REDIRECT_URI` to the exact registered callback. When omitted, the callback is derived from `APP_ORIGIN`. Never expose the client secret in frontend code or commit it.

Google sign-in requests `openid`, `email`, and `profile` so the signed-in drawer can show the current Google account's name, verified email, and avatar. The backend uses Google's discovery document, S256 PKCE, one-time state and nonce checks, and verifies the RS256 ID-token signature, issuer, audience, subject, issue/expiry times, and nonce. The authenticated session keeps the verified provider identifier, authentication time, and display values needed by the sidebar. PostgreSQL stores only the stable Google subject and verified email; name and avatar remain session-only. Provider tokens and client credentials are never stored. Until Google credentials are configured, the button reports that sign-in is unavailable, while Fayda and guest access remain unchanged.

The stable Google subject and verified email are stored in PostgreSQL in `stemma_google_identities` so authentication can recognize the same account across sessions. Name and avatar are not persisted as separate identity data; they stay only in the authenticated session for the existing sidebar. Fayda identity claims are not added to this table. Student-entered first name, optional middle name, last name, student ID, and department can be stored separately in `stemma_student_profiles`, keyed only to the authenticated Google subject.

The backend exposes `GET /api/student-profile` (`{ "profile": object | null }`) and `PUT /api/student-profile` (`{ "profile": object }`) for Google-authenticated sessions. PUT requires a same-origin `Origin` and `application/json`; the server validates and trims the allowed fields before writing. The client-supplied body cannot select or change the account identity. Profile data is read from PostgreSQL on demand and is not stored in browser storage.

## Session storage and deployment

The default in-memory session store is for local development and automated tests only. It is not suitable for a production or multi-instance deployment. Production startup requires PostgreSQL connection variables (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, and `DB_PASSWORD`), an HTTPS `APP_ORIGIN`, and a strong `SESSION_SECRET`. The PostgreSQL session table is created automatically; database connections use TLS. Wasmer's managed PostgreSQL database injects the required `DB_*` variables when enabled in `app.yaml`.
At startup, Stemma applies the additive, idempotent migrations in `migrations/001_google_identities.sql` and `migrations/002_student_profiles.sql` before listening; the profile table references the Google identity table and does not delete or rewrite existing data. Production Google sign-in requires the PostgreSQL identity store in addition to the PostgreSQL session store. The current dashboard is a visual skeleton: it does not collect wallet balances, transactions, cards, or goals.
Wasmer terminates HTTPS at its reverse proxy, so `app.yaml` sets `TRUST_PROXY: '1'`. This lets Express recognize the original HTTPS request and emit the secure session cookie required to preserve OIDC state across the provider round trip. For other hosting environments, set `TRUST_PROXY` only to the actual number of trusted proxy hops; do not trust arbitrary client-supplied forwarding headers.

Serve the app over HTTPS in production. Keep sandbox and production clients, keys, issuers, callback URIs, and secrets separate. Fayda sign-in remains unavailable until Stemma's own client ID, signing key, issuer, and registered callback are configured; no demo credentials are used. Configure the exact callback URI with Fayda before attempting a live sandbox round trip. Confirm PKCE support, client-assertion expiry, locale/ACR values, and signed UserInfo claims with Fayda; the public discovery and partner materials contain open discrepancies. This is eSignet sign-in, not e-KYC or financial identity verification.

## Tests and checks

```bash
npm test
npm run check
```

The automated authentication tests use mock OIDC providers and generated ephemeral keys; they never call Google or Fayda and contain no real credentials. They cover the authorization request, PKCE verification, token and ID-token validation, state mismatch and replay rejection, session rotation, logout origin protection, and provider cancellation.

## UI features

- Responsive dashboard layout with mobile bottom navigation
- Cards, Activity, Overview, Goals, and Profile sections
- Hash-based section navigation, tab selection, drawer navigation, and touch-swipe navigation
- Google and Fayda sign-in choices with a guest path
- `Skip` guest access remains available

## Teacher Attendance — first trusted System App

Open **Pulse → App → Teacher Attendance**, or return directly to `/#apps`. The launcher uses exactly three columns of large icons. Attendance opens at `/system-apps/attendance/` as a full-page app with its own **Roll** identity and no Stemma dashboard chrome. Full-page means viewport-filling; the browser Fullscreen API is not required.

`system-apps/apps.json` is the bundled application registry; `system-apps/schema.json` describes its configuration. Entries include name, description, icon, splash image, trust, language, launch link, install/build/start commands, environment requirements, and persistence permissions. Commands are deployment metadata, never browser-executed. Remote extensions are not part of this trusted registry or granted its APIs.

```bash
npm ci
npm run build:system-apps
npm run check
npm start
```

The strict TypeScript source is `system-apps/attendance/app.ts`; compiled `app.js` is checked in for the hosted runtime. `npm run build` also compiles System Apps. The app reuses the existing secure Google session and PostgreSQL configuration: `SESSION_SECRET`, `APP_ORIGIN`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, and `DB_PASSWORD`. Configure the existing Google sign-in client for local development. Never put secret values in the public registry.

Import plain, bulleted, or numbered names, one per line (up to 1,000 names, 120 characters each). Imports append and deduplicate exact Unicode/whitespace-normalized names. Students with identical full names need an identifying suffix. Individual ticks, select-all/clear-all, the local-date picker, and automatic saving form the attendance workflow. Reopen any previous date with the date picker. No synthetic roster is shipped to real accounts.

Migration `017_teacher_attendance.sql` runs idempotently at startup. Roster and dated attendance snapshots, including all-absent days, live in PostgreSQL scoped to the signed-in Google subject. Imports/saves are transactional; APIs and composite foreign keys reject cross-account student IDs. Account deletion cascades the roster and snapshots. Writes require same-origin JSON and data responses are private/no-store. No new volume or separate database is required.

```bash
STEMMA_ATTENDANCE_POSTGRES_TEST=1 node --test test/attendance-api.test.js
```

### Wasmer storage capacity

The inspected account is on Wasmer Free with a measured 1 GiB volume quota (`1073741824` bytes) and no app volumes. The requested 100 GB is not included. Volumes are mounted using `volumes: [{ name: data, mount: /data }]` in `app.yaml`; the documented configuration has no size/reservation field. Capacity is an account allowance, not an app-level 100 GB switch. No volume allocation, plan upgrade, billing change, or charge was made. Attendance uses existing managed PostgreSQL.

Wasmer's [published pricing](https://wasmer.io/pricing) lists Pro at $10/month, including 1 GB of volume storage, then $0.05 per additional GB. At that rate, 99 additional GB calculates to $4.95 in addition to the plan; the storage meter period and taxes need checkout confirmation before approval or charging. See the [volume guide](https://docs.wasmer.io/edge/guides/volumes/) and [configuration reference](https://docs.wasmer.io/edge/configuration/).

## Likee media posting

The Likee composer uses Gallery only (photos or videos); File and Camera remain available in their existing non-Likee areas. A photo/video preview is required before Post, and videos must be no longer than 240 seconds, inclusive. Likee uploads original binary bytes with real XMLHttpRequest upload percentage and MB progress, retaining authenticated, same-origin access and PostgreSQL BYTEA persistence.

Likee's practical per-media safety limit is **256 MiB (268,435,456 bytes)** in the picker, API, and database. Four minutes at 8 Mbps video plus 256 kbps audio takes 247,680,000 bytes, leaving room within this limit for container overhead. This supports that four-minute 1080p encoding budget; unusually high-bitrate media exceeding 256 MiB must be reduced before posting. No client-side compression, additional media permissions, or unrelated attachment limit changes are introduced. The Likee binary uploader has no fixed three-minute client timeout; other uploaders retain their existing defaults. Legacy small JSON uploads remain compatible.
