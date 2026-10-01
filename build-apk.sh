#!/usr/bin/env bash
# Adonai POS Android APK Build & Packaging Script
set -e
echo "Starting Adonai POS Android APK Build..."
node scripts/build-pos-apk.js
echo "Build complete. Install the generated APK on your Android device."
