#!/usr/bin/env node
/**
 * Adonai Store — Android APK Builder (POS + Delivery)
 *
 * This invokes a REAL Android/Gradle build. The previous version of this script
 * simply zipped the manifest + assets, which produced a file named *.apk that
 * Android can never install (no classes.dex, no compiled resources.arsc, no
 * signature). The output of this script is a compiled, signed, installable APK.
 *
 * Two separately installable apps share one native shell:
 *   --app=pos      (default) Adonai POS       com.adonaithrift.pos      dist/adonai-pos-v2.apk
 *   --app=delivery           Adonai Delivery  com.adonaithrift.delivery dist/adonai-delivery.apk
 * The target travels to Gradle as ADONAI_APP_TARGET and selects the
 * applicationId, launcher label/icon, bundled web app and start page. The
 * delivery APK contains the rider-partner app only — never the POS register.
 *
 * Requirements:
 *   - JDK 17 (JAVA_HOME)
 *   - Android SDK (ANDROID_HOME / ANDROID_SDK_ROOT) with platform 34 + build-tools
 *   - Gradle (uses ./gradlew when present, otherwise the `gradle` on PATH)
 *
 * Usage:
 *   node scripts/build-pos-apk.js                     # POS release (signed)
 *   node scripts/build-pos-apk.js --debug             # POS debug (debug-signed)
 *   node scripts/build-delivery-apk.js                # Delivery release (signed)
 *   node scripts/build-delivery-apk.js --debug        # Delivery debug
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { bundle } = require('./bundle-pos');
const { bundleDelivery } = require('./bundle-delivery');

const ROOT = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(ROOT, 'android');
const DIST_DIR = path.join(ROOT, 'dist');

const APPS = {
  pos: {
    label: 'Adonai POS',
    packageId: 'com.adonaithrift.pos',
    outputBase: 'adonai-pos-v2',
    bundleAssets: bundle
  },
  delivery: {
    label: 'Adonai Delivery',
    packageId: 'com.adonaithrift.delivery',
    outputBase: 'adonai-delivery',
    bundleAssets: bundleDelivery
  }
};

function parseTarget(argv) {
  const flag = argv.find(arg => arg.startsWith('--app='));
  if (flag) return flag.slice('--app='.length).toLowerCase();
  if (argv.includes('--delivery')) return 'delivery';
  return (process.env.ADONAI_APP_TARGET || 'pos').toLowerCase();
}

function fail(msg) {
  console.error('\n[APK Builder] ERROR: ' + msg + '\n');
  process.exit(1);
}

function which(cmd) {
  try {
    return execSync(`command -v ${cmd}`, { encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

function checkToolchain() {
  const javaHome = process.env.JAVA_HOME;
  if (!which('java') && !javaHome) {
    fail('Java (JDK 17) not found. Install a JDK 17 and set JAVA_HOME.');
  }
  const javac = javaHome ? path.join(javaHome, 'bin', 'javac') : which('javac');
  if (!javac || !fs.existsSync(javac)) fail('A full JDK is required (javac is missing), not a JRE. CI supplies JDK 17.');
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk || !fs.existsSync(sdk)) {
    fail(
      'Android SDK not found. Install the SDK (platform-34 + build-tools;34.0.0)\n' +
      '  and export ANDROID_HOME=/path/to/android-sdk.\n' +
      '  CI does this automatically via .github/workflows/build-pos-apk.yml.'
    );
  }
}

function gradleCommand() {
  const wrapper = path.join(ANDROID_DIR, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  if (fs.existsSync(wrapper)) return wrapper;
  const gradle = which('gradle');
  if (!gradle) fail('Neither android/gradlew nor a `gradle` binary was found on PATH.');
  return gradle;
}

/**
 * Generate a local keystore so release builds are properly signed even when no
 * secret keystore is configured. Android REFUSES to install unsigned APKs.
 */
function ensureKeystore() {
  if (process.env.ADONAI_KEYSTORE_FILE && fs.existsSync(process.env.ADONAI_KEYSTORE_FILE)) {
    console.log('[APK Builder] Using keystore from ADONAI_KEYSTORE_FILE.');
    return;
  }
  const keystore = path.join(ANDROID_DIR, 'adonai-local-release.keystore');
  const pass = 'adonaipos';
  if (!fs.existsSync(keystore)) {
    const keytool = process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, 'bin', 'keytool')
      : 'keytool';
    console.log('[APK Builder] No keystore configured — generating a local signing key...');
    execFileSync(keytool, [
      '-genkeypair', '-v',
      '-keystore', keystore,
      '-alias', 'adonaipos',
      '-keyalg', 'RSA', '-keysize', '2048',
      '-validity', '10000',
      '-storepass', pass, '-keypass', pass,
      '-dname', 'CN=Adonai Store, OU=POS, O=Adonai, L=Kampala, C=UG'
    ], { stdio: 'inherit' });
  }
  process.env.ADONAI_KEYSTORE_FILE = keystore;
  process.env.ADONAI_KEYSTORE_PASSWORD = pass;
  process.env.ADONAI_KEY_ALIAS = 'adonaipos';
  process.env.ADONAI_KEY_PASSWORD = pass;
}

function verifyApk(apkPath) {
  // 1. Structural check: a real APK must contain compiled code + resources.
  const listing = execSync(`unzip -l "${apkPath}"`, { encoding: 'utf8' });
  const required = ['classes.dex', 'resources.arsc', 'AndroidManifest.xml'];
  const missing = required.filter(entry => !listing.includes(entry));
  if (missing.length) {
    fail('Produced file is not a valid APK, missing: ' + missing.join(', '));
  }
  const signed = listing.includes('META-INF/') &&
    (listing.includes('.RSA') || listing.includes('.DSA') || listing.includes('.EC'));

  // 2. Signature check with apksigner when available.
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  let apksigner = null;
  if (sdk && fs.existsSync(path.join(sdk, 'build-tools'))) {
    const versions = fs.readdirSync(path.join(sdk, 'build-tools')).sort();
    for (const v of versions.reverse()) {
      const candidate = path.join(sdk, 'build-tools', v, 'apksigner');
      if (fs.existsSync(candidate)) { apksigner = candidate; break; }
    }
  }
  if (apksigner) {
    try {
      const out = execSync(`"${apksigner}" verify --verbose "${apkPath}"`, { encoding: 'utf8' });
      console.log('[APK Builder] apksigner verification:\n' + out.trim());
    } catch (e) {
      fail('APK signature verification failed — Android would reject this install.\n' +
        (e.stdout || e.message));
    }
  } else if (!signed) {
    fail('APK appears to be unsigned (no META-INF signature block).');
  }
  console.log('[APK Builder] APK structure + signature OK.');
}

function buildApk(options = {}) {
  const target = (options.target || parseTarget(process.argv)).toLowerCase();
  const app = APPS[target];
  if (!app) fail(`Unknown app target "${target}". Use --app=pos or --app=delivery.`);
  const isDebug = options.debug !== undefined ? options.debug : process.argv.includes('--debug');
  const variant = isDebug ? 'debug' : 'release';
  const preview = process.env.ADONAI_PREVIEW_BUILD === '1';

  console.log('====================================================');
  console.log(`${app.label} — Android APK Build (${variant})`);
  console.log('====================================================\n');

  checkToolchain();

  // The Gradle build reads the target from the environment. Set it before
  // bundling so the assets on disk and the compiled identity always agree.
  process.env.ADONAI_APP_TARGET = target;

  // Step 1: bundle this app's web assets into android/app/src/main/assets/public
  app.bundleAssets();

  // Step 2: signing material for release builds
  if (!isDebug) ensureKeystore();

  // Step 3: compile with Gradle. `clean` matters: the applicationId/label/icon
  // come from an env var, which Gradle cannot see as a task input — without a
  // clean, switching targets could silently reuse the other app's APK.
  const gradle = gradleCommand();
  const task = isDebug ? 'assembleDebug' : 'assembleRelease';
  console.log(`\n[APK Builder] Running ${path.basename(gradle)} clean ${task} (ADONAI_APP_TARGET=${target}) ...\n`);
  execFileSync(gradle, ['clean', task, '--no-daemon', '--stacktrace'], {
    cwd: ANDROID_DIR,
    stdio: 'inherit',
    env: process.env
  });

  // Step 4: locate the generated APK
  const outDir = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', variant);
  if (!fs.existsSync(outDir)) fail('Gradle produced no output directory: ' + outDir);
  const apk = fs.readdirSync(outDir).find(f => f.endsWith('.apk'));
  if (!apk) fail('No APK found in ' + outDir);
  const builtApk = path.join(outDir, apk);

  // Step 5: verify then publish to dist/
  verifyApk(builtApk);

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const targetFile = path.join(DIST_DIR, isDebug ? `${app.outputBase}-debug.apk` : `${app.outputBase}.apk`);
  fs.copyFileSync(builtApk, targetFile);

  const sizeMb = (fs.statSync(targetFile).size / (1024 * 1024)).toFixed(2);
  console.log('\n====================================================');
  console.log('✅ Installable Android APK built successfully');
  console.log('   ' + path.relative(ROOT, targetFile) + ` (${sizeMb} MB)`);
  console.log('   App: ' + app.label + (preview ? ' Preview (separate installation)' : ''));
  console.log('   Package: ' + app.packageId + (preview ? '.preview' : ''));
  console.log('   Version: 2.5.0' + (preview ? '-preview' : ''));
  console.log('   Install: adb install -r ' + path.relative(ROOT, targetFile));
  console.log('====================================================\n');
}

if (require.main === module) {
  buildApk();
}

module.exports = { buildApk, APPS };
