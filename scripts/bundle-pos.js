#!/usr/bin/env node
/**
 * Adonai Store POS — Mobile Asset Bundler
 * Copies standalone POS Register, Admin Console, and scripts to pos-dist and Android assets.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const POS_DIST = path.join(ROOT, 'pos-dist');
const ANDROID_ASSETS = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public');

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function bundleTo(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  // 1. Copy root-level application files. The operations console keeps its
  // script and stylesheet at the repository root, while POS/login styles live
  // in css/. Omitting styles.css makes every console destination render as
  // unstyled browser HTML inside the Android app.
  const rootFiles = [
    'pos.html',
    'admin.html',
    'login.html',
    'app.js',
    'styles.css',
    'manifest-pos.json',
    'manifest.json'
  ];
  for (const f of rootFiles) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) {
      throw new Error(`[POS Bundler] Required application file is missing: ${f}`);
    }
    fs.copyFileSync(src, path.join(targetDir, f));
  }

  // Create default index.html redirecting to pos.html inside the Capacitor / Android webview
  const indexRedirect = `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=pos.html"></head><body><script>location.replace('pos.html');</script></body></html>`;
  fs.writeFileSync(path.join(targetDir, 'index.html'), indexRedirect, 'utf8');

  // 2. Copy directories: css, js, assets
  ['css', 'js', 'assets'].forEach(dir => {
    const src = path.join(ROOT, dir);
    const dest = path.join(targetDir, dir);
    if (fs.existsSync(src)) {
      copyDirRecursive(src, dest);
    }
  });
}

function bundle() {
  console.log('[POS Bundler] Bundling POS web application assets...');
  bundleTo(POS_DIST);
  console.log('  -> Generated webDir bundle in:', path.relative(ROOT, POS_DIST));
  bundleTo(ANDROID_ASSETS);
  console.log('  -> Synchronized native Android assets in:', path.relative(ROOT, ANDROID_ASSETS));
  console.log('[POS Bundler] Build complete.');
}

if (require.main === module) {
  bundle();
}

module.exports = { bundle, POS_DIST, ANDROID_ASSETS };
