#!/usr/bin/env bash
# Adonai Delivery — Android APK build (real Gradle compile + signing)
set -euo pipefail

echo "Adonai Delivery Android APK build"
echo "Requires: JDK 17 + Android SDK (ANDROID_HOME) + Gradle"

node scripts/build-delivery-apk.js "$@"

echo "Done. Install with: adb install -r dist/adonai-delivery.apk"
