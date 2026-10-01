# Adonai POS — Android Native APK & Dual-Target Architecture

This repository operates on a **Dual-Target Architecture**:
1. **Public Web Storefront (Render Deployment)**: A lightweight, customer-facing e-commerce application served at `/` on Render. All POS/admin navigation, links, and authentication triggers are stripped from the public site.
2. **Android POS App (Native APK shell)**: A standalone POS Cashier Register application packaged as an installable Android APK (`com.adonaithrift.pos`).

---

## 📱 1. Quick Install: Direct Android APK

Download the `adonai-pos-v2-apk` artifact from the GitHub Actions
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
- Gradle 8.2 or newer (the GitHub Actions workflow provisions Gradle 8.2)

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

The default build uses the Android debug signing key to make local/CI testing
installable. Use Gradle properties `RELEASE_STORE_FILE`,
`RELEASE_STORE_PASSWORD`, `RELEASE_KEY_ALIAS`, and `RELEASE_KEY_PASSWORD` for
an app-store release signed with your production keystore.

### Open the native project in Android Studio
```bash
npm run bundle:pos
gradle -p android :app:assembleRelease
```

---

## 🌐 3. Cross-Navigation (POS to Website Only)

- Inside the Android POS app header and sidebar, staff can tap **"🌐 Open Live Web Storefront ↗"**.
- This launches an **external Android Intent** (`Intent.ACTION_VIEW`) through the native WebView bridge, opening your live Render store URL (`https://adonaithrift.ug`) in the device's default web browser (Chrome / Samsung Internet).
- **Security Rule**: The public storefront has **zero return links or triggers** to the POS app. To return to the POS register, the cashier switches back to the installed Android POS app from the phone's task manager / app drawer.

---

## 🔒 4. API & Data Synchronization (Live Stock & JWT Security)

Both the Web Storefront and the Android POS App synchronize with the backend database:

| Channel | Endpoint | Auth Required | Stock Behavior |
| :--- | :--- | :--- | :--- |
| **Web Storefront** | `GET /api/products` | Public | Reads real-time in-stock counts |
| **Web Storefront** | `POST /api/orders` (`channel="web"`) | Public | Atomically decrements database stock |
| **Android POS** | `POST /api/auth/verify` | Staff Key / PIN | Returns signed JWT Bearer Token |
| **Android POS** | `POST /api/orders` (`channel="pos"`) | **JWT / Terminal Key** | Atomically decrements database stock & logs tender |
| **Android POS** | `POST /api/products` (Intake) | **JWT / Terminal Key** | Adds new vintage piece to shared database & inventory |
| **Android POS** | `POST /api/sync/pull` | **JWT / Terminal Key** | Full operational state sync (sales, inventory, ledger) |

### Environment Variables on Render:
Set either of these in your Render Environment tab to authorize staff:
- `STAFF_TERMINAL_KEY=ADONAI-POS-2026` (POS Cashier Register access)
- `ADMIN_ACCESS_PIN=246810` (Full Admin Console + POS access)
- `JWT_SECRET=your-secure-signing-secret`

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

> ⚠️ Changing the signing key between versions makes Android refuse to upgrade
> an already-installed app ("package conflicts with an existing package"). If
> you previously installed any build with a different key, uninstall it first.

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
