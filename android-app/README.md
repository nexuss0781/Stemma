# Stemma Android 1.0.5

Android-only Capacitor project for package `app.stemma.mobile`, version name `1.0.5`, version code `6`. This directory does not change or deploy the website. The Java files in `native-src/` are copied into the Android app's Java source directory by the bundler.

## Authenticated photo validation (1.0.5)

The authenticated 1.0.4 report established a 200 native response rejected by the frontend MIME gate before body read or decode. Its `other` label cannot reveal the exact upstream media type. This patch changes only the Android-bundled store: it reads at most 1 MiB, requires a PNG/JPEG/WebP signature and a real browser decode, and normalizes the returned Blob type from validated bytes instead of trusting a missing, generic, duplicate or incorrect MIME header. GIF is recognized for diagnosis but remains unsupported, as in the existing server format policy. HTML, SVG and arbitrary data are not rendered.

Declared lengths must be positive and at most 1 MiB when present; the streamed byte count is independently capped and oversize reads are cancelled. Images are checked before decode where headers expose dimensions, and after decode, with a maximum side of 8,192 pixels and 16,777,216 total pixels. Decoding has a five-second deadline within the existing request timeout. Streamless responses fail closed instead of being buffered without a bound. Temporary decode object URLs are revoked; no bytes are cached or logged. Account authorization, cookie transport, no-store/offline rules, uploads and device-photo fallback remain unchanged.

Diagnostics separately report safe actual fetch/upstream MIME essences, inferred MIME, magic type, declared length (`missing`/`invalid` when appropriate), actual byte count and validation/decode phase. MIME parameters, URLs, bodies and arbitrary error messages are excluded. `mime` with a known unsupported signature, `non-image` with an unknown signature, and `corrupt-image` after a supported signature fails decode are distinct outcomes.

`python3 test-photo-response.py` tests real PNG/JPEG/WebP bytes, before/after strict-MIME rejection, missing/octet-stream/mismatched headers, HTML and corrupt bodies, cancellation, dimensions and size limits. `python3 test-photo-diagnostics.py` exercises both full-app photo views, the failure panel, privacy and retries with synthetic account data. These are not physical-phone or authenticated-owner-account tests; this release does not claim the owner's photo is visible.

## Smooth swipe navigation

Left swipes follow Pay fee / For You → Pay fee / For friend → Deposit → History → Pulse All → User → Group → Channel → App → Overview → Likee → Profile → Notifications. Right swipes reverse the sequence without wrapping. Horizontal finger tracking, eased settling and reduced-motion support are Android-only. Existing navigation buttons remain available.

Visited steps retain selected filters, Pulse stage, parent view and bounded scroll metadata in an account-isolated, in-memory map. Logging out clears it; the existing native persistence still restores the current screen across restarts. Deliberate swipes do not reapply an old launch deep link. Editable inputs, dialogs, open chats, story rails, other horizontal scroll owners and Likee's feed are excluded; use non-feed page chrome to leave Likee. Ordinary controls retain taps; a horizontal drag captures the pointer and suppresses its matching trailing click. Vertical gestures do not select another route, and passive notification entry does not mark records read.

After bundling, `python3 test-native-swipe-browser.py` runs trusted touch gestures in a synthetic phone-sized Chromium viewport. Its recording is a browser preview, not a physical Android recording or validation of the owner's account.

## In-app photo diagnostics

Profile now shows an expandable **Photo diagnostics** panel beneath a photo failure message. **Copy details** copies the current attempt's safe JSON report. It records the actual fetch/native proxy, validation and image load/error results: phase, fixed endpoint path, signed-in boolean, HTTP/native status, MIME, declared/delivered size when known, native error category, decode dimensions, retries, timestamp and app version. Unknown decode fields remain null; absent or malformed MIME/declared lengths use explicit safe labels. The panel disappears after a successfully decoded account photo.

Reports are memory-only, reset across account changes and never include cookie values, tokens, account identifiers, response bodies, image bytes, blob URLs or query strings. Only allowlisted categories/fields are displayed; raw exception messages are not copied. Native diagnostics are restricted to the account-photo GET. Android automatic restore never imports a device/gallery photo, including on 404. There is no new upload, automatic retry or network diagnostic probe.

The 1.0.4 release added observability; 1.0.5 corrects the now-confirmed pre-body MIME gate without claiming device/account verification. Run `python3 test-photo-diagnostics.py` after bundling for success, failure, retry, Copy details and privacy regressions. Browser tests use fixtures, not the owner's account. A physical-device authenticated test is still required to confirm the owner's photo can be displayed.

## Existing photo transport (inherited from 1.0.3)

Account-photo GET requests now use the same-origin native streaming proxy, which forwards the backend account cookie and explicitly exposes the image Content-Type header. Photo bytes and error statuses are preserved; failures do not substitute or upload a device photo. No website files or deployment are involved.

Run `sh native-proxy-tests/run.sh` for the native proxy regression harness and `python3 test-profile-photo.py` after building `www/` for photo-fetch browser regressions. The existing signing key is required for in-place updates. Emulator installation and live-account loading were not verified.

## Existing app behavior (unchanged)

- Atomic, fsync-backed app-private persistence outside Android's disposable cache, excluded from backup.
- Account-scoped navigation, parent/subtabs, nested conversation/group/channel state, attendance navigation, scroll positions and unsent drafts. Explicit links take precedence over remembered navigation.
- Cookie flushing on lifecycle transitions and every 30 seconds while resumed. WorkManager attempts hourly connected-network renewal of an existing valid server session; it does not log in, override expiry or defeat Android background restrictions.
- Response retention up to 512 MiB with a 32 MiB RAM working set. Durable media retention up to 2 GiB / 2,048 files, seven-day protection for imported copies and a 128 MiB free-space reserve. Cached thumbnails still require current per-item media authorization.
- The animated splash mark is shifted upward by 12% of viewport height while remaining horizontally centered.

Logging out purges private account caches and drafts. Clearing app storage or uninstalling removes persistent state. Android may delay background renewal; the existing backend's eight-hour rolling session can still expire.

## Build locally

Use Node.js, JDK 21 and Android SDK 36. From this directory:

```sh
npm ci
node build-web.cjs
npx cap sync android
cd android
./gradlew assembleDebug
```

The bundler reads the existing repository-root UI sources without modifying them. Set `STEMMA_WEB_SOURCE=/absolute/path` to use a separate source checkout. Generated HTML, CSS and JavaScript bundles are deliberately not tracked here.

For a release, securely provision the **existing Stemma signing key**, copy `signing/release.properties.example` to `signing/release.properties`, replace its placeholders locally, then run `./gradlew assembleRelease` from `android/`. Do not create a new key for an in-place update. Signing material, SDK paths and APKs are ignored by Git.

## Tests

`node test-native-cache.cjs` and `node test-native-navigation.cjs` exercise cache and navigation persistence. The Python Playwright suites use synthetic native bridges and accounts; serve `www/` on localhost port 8972 before running `test-bundle.py`, `test-runtime-persistence.py` and `test-navigation-browser.py`. They do not modify live accounts.

`NativePersistenceTest.java` contains Android instrumentation checks for durable state and cookie flushing. These were not executed successfully in this environment because the software emulator failed to finish booting. Release compilation, signature validation, APK integrity, JavaScript persistence, account isolation, cold-launch tab restoration and splash fallback tests passed for the delivered APK.
