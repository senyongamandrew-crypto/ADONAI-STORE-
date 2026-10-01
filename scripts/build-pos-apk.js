#!/usr/bin/env node
/**
 * Adonai Store POS — Android APK builder
 *
 * The previous builder created a ZIP file and renamed it to .apk.  That file
 * could not be installed because it contained no compiled Android resources,
 * DEX bytecode, or signing information.  This script builds the Android
 * project with the Android Gradle Plugin and only publishes the APK after it
 * has been checked for the files an installable APK must contain.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { bundle } = require('./bundle-pos');

const ROOT = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(ROOT, 'android');
const DIST_DIR = path.join(ROOT, 'dist');
const GRADLE_APK = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const RELEASE_DIR = path.dirname(GRADLE_APK);
const RELEASE_APK = path.join(RELEASE_DIR, 'adonai-pos-release.apk');
const DISTRIBUTION_APK = path.join(DIST_DIR, 'adonai-pos-v2.apk');

function commandExists(command) {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function gradleCommand() {
  const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  const wrapperPath = path.join(ANDROID_DIR, wrapper);
  if (fs.existsSync(wrapperPath)) return { command: wrapperPath, args: [] };

  const configured = process.env.GRADLE_COMMAND;
  if (configured) return { command: configured, args: [] };
  if (commandExists('gradle')) return { command: 'gradle', args: [] };

  throw new Error(
    'Gradle was not found. Install Gradle 8.2+ (and JDK 17 plus Android SDK) ' +
    'or run this build in the supplied GitHub Actions workflow.'
  );
}

function runGradle() {
  const gradle = gradleCommand();
  console.log(`\n[APK Builder] Running ${path.basename(gradle.command)} :app:assembleRelease...`);

  const result = spawnSync(
    gradle.command,
    [...gradle.args, '--no-daemon', '--stacktrace', ':app:assembleRelease'],
    { cwd: ANDROID_DIR, stdio: 'inherit', env: process.env }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Gradle failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

function apkEntries(apkPath) {
  try {
    return execFileSync('unzip', ['-Z1', apkPath], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map(entry => entry.trim())
      .filter(Boolean);
  } catch (error) {
    throw new Error(`The generated file is not a readable APK archive: ${error.message}`);
  }
}

function verifyApk(apkPath) {
  if (!fs.existsSync(apkPath) || fs.statSync(apkPath).size === 0) {
    throw new Error(`Gradle did not produce an APK at ${path.relative(ROOT, apkPath)}.`);
  }

  const entries = apkEntries(apkPath);
  const required = ['AndroidManifest.xml', 'classes.dex', 'resources.arsc'];
  const missing = required.filter(name => !entries.includes(name));
  if (missing.length) {
    throw new Error(`Generated APK is incomplete; missing ${missing.join(', ')}.`);
  }

  // assembleRelease is configured with a local debug signing key by default so
  // the downloaded artifact is installable. A production keystore can replace
  // it through the Gradle signing properties documented in the setup guide.
  if (!entries.some(entry => entry.startsWith('META-INF/') && /\.(RSA|DSA|EC)$/i.test(entry))) {
    throw new Error('Generated APK is unsigned and cannot be installed on Android.');
  }

  return {
    bytes: fs.statSync(apkPath).size,
    entries: entries.length
  };
}

function buildApk() {
  console.log('====================================================');
  console.log('Adonai POS Android APK Build Pipeline');
  console.log('Target: Installable Android POS terminal');
  console.log('====================================================\n');

  // Keep the native asset bundle in sync with the source web application.
  bundle();
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(RELEASE_DIR, { recursive: true });

  // Never leave a previous APK looking like a successful build when Gradle
  // fails. The old implementation did exactly that with a plain ZIP archive.
  for (const output of [DISTRIBUTION_APK, RELEASE_APK]) {
    if (fs.existsSync(output)) fs.rmSync(output, { force: true });
  }

  runGradle();
  const result = verifyApk(GRADLE_APK);

  fs.copyFileSync(GRADLE_APK, RELEASE_APK);
  fs.copyFileSync(GRADLE_APK, DISTRIBUTION_APK);

  const sizeMb = (result.bytes / (1024 * 1024)).toFixed(2);
  console.log('\n====================================================');
  console.log('✅ Android POS APK built and verified successfully.');
  console.log(`  ${path.relative(ROOT, DISTRIBUTION_APK)} (${sizeMb} MB)`);
  console.log(`  ${path.relative(ROOT, RELEASE_APK)}`);
  console.log(`  Verified archive entries: ${result.entries}`);
  console.log('====================================================\n');
}

if (require.main === module) {
  try {
    buildApk();
  } catch (error) {
    console.error(`\n[APK Builder Error] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { buildApk, verifyApk };
