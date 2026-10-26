#!/usr/bin/env node
/**
 * Adonai Delivery — Mobile Asset Bundler
 *
 * Copies ONLY the rider-partner application (delivery.html + js/delivery-app.js)
 * to delivery-dist and the Android assets folder. The delivery APK must never
 * contain the POS register or Admin Suite: riders install a separate app that
 * opens straight into rider sign-in. The target folder is cleaned first so a
 * previous POS bundle can never leak POS pages into the delivery APK.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DELIVERY_DIST = path.join(ROOT, 'delivery-dist');
const ANDROID_ASSETS = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public');

/** Every file the rider app loads, as repo-relative paths. Kept lean on purpose:
 * no catalog photos and no POS/admin scripts ride along on a rider's phone. */
const DELIVERY_FILES = [
  'delivery.html',
  'manifest-delivery.json',
  'sw-delivery.js',
  'css/delivery.css',
  'js/delivery-app.js',
  'assets/delivery-icon-192.png',
  'assets/delivery-icon-512.png',
  'assets/delivery-icon-maskable-512.png',
  'assets/delivery-apple-touch.png',
  'assets/adonai-logo-horizontal-light.svg'
];

function bundleTo(targetDir) {
  // Clean first: the Android assets folder is shared with the POS bundle, and
  // a leftover pos.html in a delivery build would hand riders the register.
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  for (const f of DELIVERY_FILES) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) {
      throw new Error(`[Delivery Bundler] Required application file is missing: ${f}`);
    }
    const dest = path.join(targetDir, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  // Default entry inside the Android WebView: the rider app, never the POS.
  const indexRedirect = `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=delivery.html"></head><body><script>location.replace('delivery.html');</script></body></html>`;
  fs.writeFileSync(path.join(targetDir, 'index.html'), indexRedirect, 'utf8');
}

function bundleDelivery() {
  console.log('[Delivery Bundler] Bundling Adonai Delivery web application assets...');
  bundleTo(DELIVERY_DIST);
  console.log('  -> Generated webDir bundle in:', path.relative(ROOT, DELIVERY_DIST));
  bundleTo(ANDROID_ASSETS);
  console.log('  -> Synchronized native Android assets in:', path.relative(ROOT, ANDROID_ASSETS));
  console.log('[Delivery Bundler] Build complete.');
}

if (require.main === module) {
  bundleDelivery();
}

module.exports = { bundleDelivery, DELIVERY_DIST, ANDROID_ASSETS, DELIVERY_FILES };
