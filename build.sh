#!/usr/bin/env bash
# Builds Chrome (MV3) and Firefox (MV2) packages into dist/artifacts/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo dev)"
DIST="$ROOT/dist"
ART="$DIST/artifacts"

# Validate manifests are well-formed JSON before packaging.
node -e "JSON.parse(require('fs').readFileSync('manifest.chrome.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('manifest.firefox.json','utf8'))"

# Generate icons if they are missing.
if [ ! -f "$ROOT/src/icons/icon-128.png" ]; then
  node "$ROOT/tools/make-icons.mjs"
fi

rm -rf "$DIST"
mkdir -p "$DIST/chrome" "$DIST/firefox" "$ART"

# Chrome (Manifest V3)
cp -r "$ROOT/src/." "$DIST/chrome/"
cp "$ROOT/manifest.chrome.json" "$DIST/chrome/manifest.json"

# Firefox (Manifest V2)
cp -r "$ROOT/src/." "$DIST/firefox/"
cp "$ROOT/manifest.firefox.json" "$DIST/firefox/manifest.json"

CHROME_ZIP="$ART/adaptive-video-downloader-chrome-v$VERSION.zip"
FIREFOX_ZIP="$ART/adaptive-video-downloader-firefox-v$VERSION.zip"

( cd "$DIST/chrome" && zip -qr -X "$CHROME_ZIP" . )
( cd "$DIST/firefox" && zip -qr -X "$FIREFOX_ZIP" . )

# A Firefox .xpi is just a renamed zip.
cp "$FIREFOX_ZIP" "$ART/adaptive-video-downloader-firefox-v$VERSION.xpi"

echo ""
echo "Built v$VERSION:"
ls -la "$ART"
