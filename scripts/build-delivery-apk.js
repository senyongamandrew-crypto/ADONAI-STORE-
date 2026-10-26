#!/usr/bin/env node
/**
 * Adonai Delivery — Android APK Builder
 *
 * Builds the standalone rider-partner APK (com.adonaithrift.delivery,
 * dist/adonai-delivery.apk) with the shared Gradle builder in
 * scripts/build-pos-apk.js. This app opens straight into rider sign-in and
 * contains no POS register or Admin Suite pages.
 *
 * Usage:
 *   node scripts/build-delivery-apk.js            # release build (signed)
 *   node scripts/build-delivery-apk.js --debug    # debug build (debug-signed)
 */
const { buildApk } = require('./build-pos-apk');

if (require.main === module) {
  buildApk({ target: 'delivery', debug: process.argv.includes('--debug') });
}

module.exports = { buildApk };
