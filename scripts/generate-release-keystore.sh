#!/usr/bin/env bash
# Adonai POS — generate a permanent release signing keystore and print the
# values to paste into GitHub repository secrets.
#
# Usage: ./scripts/generate-release-keystore.sh [output.keystore]
#
# KEEP THE GENERATED FILE AND PASSWORDS SAFE AND BACKED UP.
# Losing them means you can never ship an upgrade to an installed app again
# (Android refuses to update an app signed with a different key).
set -euo pipefail

OUT="${1:-adonai-release.keystore}"
ALIAS="${ADONAI_KEY_ALIAS:-adonaipos}"

if [ -f "$OUT" ]; then
  echo "Refusing to overwrite existing keystore: $OUT" >&2
  exit 1
fi

read -r -s -p "Choose a keystore password (min 6 chars): " PASS; echo
read -r -s -p "Repeat password: " PASS2; echo
[ "$PASS" = "$PASS2" ] || { echo "Passwords do not match." >&2; exit 1; }

keytool -genkeypair -v \
  -keystore "$OUT" \
  -alias "$ALIAS" \
  -keyalg RSA -keysize 2048 \
  -validity 10000 \
  -storepass "$PASS" -keypass "$PASS" \
  -dname "CN=Adonai Thrift Store, OU=POS, O=Adonai Thrift Store, L=Kampala, C=UG"

echo
echo "Keystore created: $OUT"
echo
echo "Add these GitHub repository secrets (Settings > Secrets and variables > Actions):"
echo "  ANDROID_KEYSTORE_BASE64     = (contents below)"
echo "  ANDROID_KEYSTORE_PASSWORD   = your password"
echo "  ANDROID_KEY_ALIAS           = $ALIAS"
echo "  ANDROID_KEY_PASSWORD        = your password"
echo
echo "----- ANDROID_KEYSTORE_BASE64 -----"
base64 -w0 "$OUT" 2>/dev/null || base64 "$OUT"
echo
echo "-----------------------------------"
echo "Do NOT commit the keystore — *.keystore is gitignored."
