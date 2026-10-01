#!/usr/bin/env bash
# Adonai POS — Android APK build (real Gradle compile + signing)
set -euo pipefail

echo "Adonai POS Android APK build"
echo "Requires: JDK 17 + Android SDK (ANDROID_HOME) + Gradle"

node scripts/build-pos-apk.js "$@"

echo "Done. Install with: adb install -r dist/adonai-pos-v2.apk"
