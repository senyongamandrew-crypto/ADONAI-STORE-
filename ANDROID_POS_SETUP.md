# Adonai POS — Android Native APK & Dual-Target Architecture

This repository operates on a **Dual-Target Architecture**:
1. **Public Web Storefront (Render Deployment)**: A lightweight, customer-facing e-commerce application served at `/` on Render. All POS/admin navigation, links, and authentication triggers are stripped from the public site.
2. **Android POS App (Native APK shell)**: A standalone POS Cashier Register application packaged as an installable Android APK (`com.adonaithrift.pos`).

---

## 📱 1. Quick Install: Direct Android APK

### What “rebuild” and “phone testing” mean

The developer/GitHub workflow **rebuilds** the APK: it compiles the changed Java
GPS service and packages the latest screens into one signed installation file.
Downloading an old release or the repository's source ZIP does not install the
new service. **You do not need Android Studio, Java, Gradle or build commands on
your phone.** Download the freshly built APK and open it to install.

Builds from `arena/**` branches use **Adonai Store Preview**
(`com.adonaithrift.pos.preview`, version `2.5.0-preview`). This installs alongside
your existing POS, avoiding unknown signing-key conflicts and preserving its
local data. Do not uninstall the old app or clear its data. The preview is a
separate app sandbox; unsynced old-phone data is not copied into it automatically.

The builder verifies Android bytecode/resources, signature, foreground-location
service/permissions and source-identical rider assets. `BUILD-INFO.json` and
`SHA256SUMS.txt` identify the commit and download. A successful build means an
installation file is available, **not** that we have physically tested your
phone's GPS/battery restrictions. Phone testing simply means installing it,
approving Location/notifications, pairing your authorized device, starting duty,
locking the screen and checking that fresh points continue and Stop works.

The updated backend must separately be deployed to your store's HTTPS origin
for pairing, scoped dispatch, media and export endpoints to work. An APK build
never deploys backend code or changes the live SQL store by itself. Use the
updated preview server for a controlled check until the backend update is approved.

Download `adonai-pos-v2.5.0-preview.apk` from the new preview release, or
download the `adonai-pos-v2-apk` artifact from the GitHub Actions
`build-pos-apk` job, or use the APK attached to a tagged GitHub release. A
local build creates the same files at:
- `dist/adonai-pos-v2.apk`
- `android/app/build/outputs/apk/release/adonai-pos-release.apk`

### Installation Steps on Android Devices:
1. **Transfer APK to Device**: Copy the verified APK to your Android phone or POS tablet (via USB cable, Google Drive, WhatsApp file share, or ADB).
2. **Enable Unknown Sources**: On your Android device, go to **Settings → Security** and allow **Install Unknown Apps** for your file browser.
3. **Install**: Tap `adonai-pos-v2.apk` on your device and tap **Install**.
4. **Via ADB command line (if connected)**:
   ```bash
   adb install -r dist/adonai-pos-v2.apk
   ```

---

## 🔨 2. Native Android Build Commands

The APK is built by the Android Gradle Plugin. The old packaging step that
renamed a ZIP archive to `.apk` has been removed.

### Required build tools
- JDK 17
- Android SDK platform 34 and build-tools
- Gradle 8.2 or newer (the GitHub Actions workflow provisions Gradle 8.6)

### Direct APK Compilation:
```bash
npm install
./build-apk.sh
# or
npm run build:apk
```

The command first bundles the latest POS assets, runs
`:app:assembleRelease`, and verifies that the result contains compiled
`AndroidManifest.xml`, `classes.dex`, `resources.arsc`, and signing metadata.
It outputs the installable APK to `dist/adonai-pos-v2.apk`.

The builder uses the configured release keystore, or generates a local signing
key for installation checks. Use the `ADONAI_KEYSTORE_*` variables documented
below for a stable, upgradeable production signing identity. Branch preview
builds have a separate application ID and cannot overwrite the existing POS.

### Open the native project in Android Studio
```bash
npm run bundle:pos
gradle -p android :app:assembleRelease
```

---

### Operator notification bell

Deploy the updated backend and rebuild/install the APK to receive the new
notification client. Its bell fetches durable history immediately, refreshes
in the foreground every 5 seconds, and refreshes promptly after local checkout
or stock/settings actions. The drawer shows connection status, a Refresh
button, unread state and links to the relevant console workspace. Checkouts
and actual store changes now reach the bell, independently of navigation
counts. Locked areas still provide a generic activity alert; their protected
customer/financial details require the assigned password. No additional
notification-service keys are required.

---

## 🌐 3. Cross-Navigation (POS to Website Only)

- Inside the Android POS navigation drawer, staff can tap **"🌐 Open Live Web Storefront ↗"**. It is intentionally kept out of dashboard headers.
- This launches an **external Android Intent** (`Intent.ACTION_VIEW`) through the native WebView bridge, opening your live Render store URL (`https://adonai-store.onrender.com`) in the device's default web browser (Chrome / Samsung Internet).
- **Security Rule**: The public storefront has **zero return links or triggers** to the POS app. To return to the POS register, the cashier switches back to the installed Android POS app from the phone's task manager / app drawer.

---

## 🔒 4. API & Data Synchronization (Live Stock & JWT Security)

Both the Web Storefront and the Android POS App synchronize with the backend database:

| Channel | Endpoint | Auth Required | Stock Behavior |
| :--- | :--- | :--- | :--- |
| **Web Storefront** | `GET /api/products` | Public | Reads real-time in-stock counts |
| **Web Storefront** | `POST /api/orders` (`channel="web"`) | Public | Atomically decrements database stock |
| **Android POS** | `POST /api/auth/terminal-session` | Public in PIN-free mode | Automatically receives a signed admin JWT; no login needed |
| **Android POS** | `POST /api/auth/verify` | Optional protected mode only | Verifies a configured Staff Key / PIN |
| **Android POS** | `POST /api/orders` (`channel="pos"`) | **None by default; area password if protected** | Atomically decrements database stock & logs tender |
| **Android POS** | `POST /api/products` (Intake) | **None by default; area password if protected** | Adds Brand-New Apparel or Curated Pre-Loved / Vintage stock to shared database & inventory |
| **Android POS** | `POST /api/sync/pull` | **None by default; area password if protected** | Full operational state sync (sales, inventory, ledger) |

### Terminal Access on Render:
The register always opens directly. Optional passwords are configured in
**Store Settings → Passwords & protected areas**. Set an admin password, create
one or a batch of named area passwords, and assign them to finance, stock/intake,
orders/dispatch or store settings. Checkout and scanning never need a password.

Unlocks are verified by the backend and last 30 minutes per tab. Navigation and
reload preserve them; password rotation/disable/delete revokes them immediately.
The admin password protects the rules and is a backup for all protected areas.
Area passwords use database-backed sessions, not environment keys or JWTs.

- `ADONAI_REQUIRE_STAFF_AUTH=0` (default: PIN-free access)
- `JWT_SECRET=<long-random-signing-secret>` (keep this server-side in production)
- Optional credential protection: set `ADONAI_REQUIRE_STAFF_AUTH=1` and configure
  `STORE_MASTER_KEY` / `STAFF_TERMINAL_KEY` with unique secrets in Render.

**Warning:** areas you leave unprotected remain accessible to anyone who can
reach the terminal. Complete initial admin setup on a trusted device. Use trusted/private devices and restrict network access where
needed. Existing credential variables alone do not re-enable the login lock.

---

## 🤖 5. Automated CI/CD & GitHub Actions

The repository includes a GitHub Actions workflow in `.github/workflows/build-pos-apk.yml`.

### Key Capabilities:
- **Automatic Builds**: On every push to `main` and PR, the workflow automatically validates backend test suites and builds the Android POS APK.
- **Artifact Downloads**: The compiled `dist/adonai-pos-v2.apk` is uploaded as an artifact to each GitHub Action run. You can download the latest APK directly from the **Actions** tab on GitHub without local build tooling.
- **Automated Releases**: Pushing a version tag (e.g., `git tag v2.4.0 && git push origin v2.4.0`) or triggering the action manually (`workflow_dispatch`) creates a GitHub Release with `adonai-pos-v2.apk` attached.


---

## Building an installable APK (v2.x)

> **Why the earlier `adonai-pos-v2.apk` would not install:** it was produced by
> zipping `AndroidManifest.xml`, `res/` and `assets/` together and renaming the
> zip to `.apk`. A real APK must contain **compiled** Dalvik bytecode
> (`classes.dex`), **compiled** resources (`resources.arsc`, binary XML) and a
> valid **APK signature** block. Without these, Android's package installer
> rejects the file with "App not installed" / "There was a problem parsing the
> package". The build now runs a real Gradle/AGP compile and signs the output.

### Prerequisites
- JDK 17 (`JAVA_HOME` set)
- Android SDK with `platforms;android-34` and `build-tools;34.0.0`, `ANDROID_HOME` set
- Node.js 20, Gradle 8.x (or add the Gradle wrapper with `gradle wrapper` inside `android/`)

### Commands
```bash
npm run bundle:pos        # copy POS web assets into android/app/src/main/assets/public
npm run build:apk         # signed release APK  -> dist/adonai-pos-v2.apk
npm run build:apk:debug   # debug APK           -> dist/adonai-pos-v2-debug.apk
```
The builder verifies the output with `apksigner verify` and fails the build if
the APK is unsigned or missing `classes.dex` / `resources.arsc`.

### Signing
Release builds use a keystore from these env vars / Gradle properties:

| Variable | Meaning |
|---|---|
| `ADONAI_KEYSTORE_FILE` | path to the `.keystore` / `.jks` |
| `ADONAI_KEYSTORE_PASSWORD` | store password |
| `ADONAI_KEY_ALIAS` | key alias |
| `ADONAI_KEY_PASSWORD` | key password |

If none are set, the script generates `android/adonai-local-release.keystore`
(gitignored) so the APK is still installable for internal distribution. For a
stable, upgradeable signing identity in CI, store a base64 keystore as the
repository secret `ANDROID_KEYSTORE_BASE64` plus `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

> Changing the signing key makes Android refuse an in-place upgrade. **Do not
> uninstall the existing POS or clear its data just to resolve this**: unsynced
> phone data can be lost. Use the separate preview build while the production
> signing identity is confirmed; normal upgrades must reuse the original key.

### Installing on the phone
```bash
adb install -r dist/adonai-pos-v2.apk
```
Or copy the APK to the device, enable **Install unknown apps** for the app doing
the opening (Chrome / Files), and tap it. Minimum Android version: 5.1 (API 22).

### CI
`.github/workflows/build-pos-apk.yml` installs JDK 17 + the Android SDK, builds
both variants, verifies signatures, and uploads them as workflow artifacts
(`adonai-pos-v2-apk`, `adonai-pos-v2-debug-apk`).


### Garment-camera scanning and hangtag printing

Rebuild and reinstall the APK after updating `MainActivity.java`. The native
shell permits only video-capture requests from `https://appassets.androidplatform.net`
and prompts for Android's CAMERA permission at runtime. It never grants
microphone permission. The web scanner stops its camera when closed, when a
scan succeeds, or when the app is backgrounded.

**Scan Tag** uses native barcode decoding where available, with a bundled ZXing
fallback. **Save & Print Tag** / reprints use Android's system print service
through a separate WebView with JavaScript, native bridges, file access and
network loading disabled. Choose the printer's actual media size and use an
installed print-service plugin; direct Bluetooth commands are not implemented.
The APK changes need on-device camera and printer acceptance testing; the
web preview alone cannot validate a particular physical printer.

### Rider foreground GPS (included in the newly built APK; phone QA required)

The same shell now includes `rider.html` and `RiderTrackingService`. A paired rider
launch reopens the rider portal, separate from the register's staff data sync.
Pairing is via a private one-use code issued in Delivery Partners & Dispatch.
GPS is never read from an IMEI/serial number and never starts on pairing alone.

Location sharing needs runtime coarse/fine Location permission plus a visible
notification; API 34 declares the location foreground-service type/permission.
The rider approves a per-duty consent dialog and has an ongoing notification
with **Stop sharing**. This service is designed to run with the screen locked,
not dependent on WebView timers. No background-location permission, boot receiver
or automatic sticky restart is requested. A duty expires after 12 hours. Network
loss shows stale positions; phone/OEM force-stop and power controls can still stop
updates. Credentials stay in app-private native preferences (backups disabled),
not JavaScript/localStorage, and HTTPS uploads do not follow redirects.

Before shipping an APK, compile with SDK 34 and verify the foreground service on
real Android phones, including permission/notification denial, approximate GPS,
locked-screen duty, Stop from notification, offline/reconnect, pairing revocation,
12-hour expiry and battery restrictions. Current automated browser bridge mocks
and Java syntax checks are not physical-device verification. See the README's
Delivery Partners & Dispatch section for endpoint/privacy/retention details.
