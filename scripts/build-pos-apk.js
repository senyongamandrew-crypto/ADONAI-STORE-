#!/usr/bin/env node
/**
 * Adonai Store POS — Android APK Builder
 *
 * This invokes a REAL Android/Gradle build. The previous version of this script
 * simply zipped the manifest + assets, which produced a file named *.apk that
 * Android can never install (no classes.dex, no compiled resources.arsc, no
 * signature). The output of this script is a compiled, signed, installable APK.
 *
 * Requirements:
 *   - JDK 17 (JAVA_HOME)
 *   - Android SDK (ANDROID_HOME / ANDROID_SDK_ROOT) with platform 34 + build-tools
 *   - Gradle (uses ./gradlew when present, otherwise the `gradle` on PATH)
 *
 * Usage:
 *   node scripts/build-pos-apk.js            # release build (signed)
 *   node scripts/build-pos-apk.js --debug    # debug build (debug-signed)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execSync } = require('child_process');
const { bundle } = require('./bundle-pos');

const ROOT = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(ROOT, 'android');
const DIST_DIR = path.join(ROOT, 'dist');

const isDebug = process.argv.includes('--debug');
const variant = isDebug ? 'debug' : 'release';

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
      '-dname', 'CN=Adonai Thrift Store, OU=POS, O=Adonai, L=Kampala, C=UG'
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

function buildApk() {
  console.log('====================================================');
  console.log('Adonai POS — Android APK Build (' + variant + ')');
  console.log('====================================================\n');

  checkToolchain();

  // Step 1: bundle web assets into android/app/src/main/assets/public
  bundle();

  // Step 2: signing material for release builds
  if (!isDebug) ensureKeystore();

  // Step 3: compile with Gradle
  const gradle = gradleCommand();
  const task = isDebug ? 'assembleDebug' : 'assembleRelease';
  console.log(`\n[APK Builder] Running ${path.basename(gradle)} ${task} ...\n`);
  execFileSync(gradle, [task, '--no-daemon', '--stacktrace'], {
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
  const target = path.join(DIST_DIR, isDebug ? 'adonai-pos-v2-debug.apk' : 'adonai-pos-v2.apk');
  fs.copyFileSync(builtApk, target);

  const sizeMb = (fs.statSync(target).size / (1024 * 1024)).toFixed(2);
  console.log('\n====================================================');
  console.log('✅ Installable Android APK built successfully');
  console.log('   ' + path.relative(ROOT, target) + ` (${sizeMb} MB)`);
  console.log('   Package: com.adonaithrift.pos  versionName 2.4.0');
  console.log('   Install: adb install -r ' + path.relative(ROOT, target));
  console.log('====================================================\n');
}

if (require.main === module) {
  buildApk();
}

module.exports = { buildApk };
