# Stemma Android 1.0.3

Android-only Capacitor project for package `app.stemma.mobile`, version name `1.0.3`, version code `4`. This directory does not change or deploy the website. The Java files in `native-src/` mirror the Android app's Java sources.

## Profile-photo fetch fix

Account-photo GET requests now use the same-origin native streaming proxy, which forwards the backend account cookie and explicitly exposes the image Content-Type header. Photo bytes and error statuses are preserved; failures do not substitute or upload a device photo. No website files or deployment are involved.

Run `sh native-proxy-tests/run.sh` for the native proxy regression harness and `python3 test-profile-photo.py` after building `www/` for photo-fetch browser regressions. The existing signing key is required for the delivered 1.0.3 update. Signature, build, and regression checks passed; emulator installation and live-account loading were not verified.

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
