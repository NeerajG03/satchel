#!/bin/bash
# Builds Satchel.app and installs it in ~/Applications. Needs only the Command Line Tools.
# The Supabase URL and publishable key are public (the web app ships them), read from
# the environment or the repo's .env and written into the app's Info.plist.
set -euo pipefail
cd "$(dirname "$0")"

setting() {
  local value="${!1:-}"
  if [ -z "$value" ] && [ -f ../.env ]; then
    value="$(grep -E "^$1=" ../.env | head -1 | cut -d= -f2- | tr -d '"' || true)"
  fi
  [ -n "$value" ] || { echo "Missing $1 (set it or add it to .env)" >&2; exit 1; }
  printf '%s' "$value"
}
URL="$(setting VITE_SUPABASE_URL)"
KEY="$(setting VITE_SUPABASE_PUBLISHABLE_KEY)"
SATCHEL_URL="${SATCHEL_URL:-https://satchel-pi.vercel.app}"

swift build -c release
APP=build/Satchel.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/Fonts"
cp .build/release/Satchel "$APP/Contents/MacOS/Satchel"
cp ../android/app/src/main/res/font/*.ttf "$APP/Contents/Resources/Fonts/"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>app.satchel.mac</string>
  <key>CFBundleName</key><string>Satchel</string>
  <key>CFBundleDisplayName</key><string>Satchel</string>
  <key>CFBundleExecutable</key><string>Satchel</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Satchel listens only while you hold ⌃⌥Space or the mic key, so you can say what you are dropping.</string>
  <key>SatchelSupabaseURL</key><string>$URL</string>
  <key>SatchelSupabaseKey</key><string>$KEY</string>
  <key>SatchelURL</key><string>$SATCHEL_URL</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP"
mkdir -p ~/Applications
rm -rf ~/Applications/Satchel.app
cp -R "$APP" ~/Applications/Satchel.app
echo "Installed ~/Applications/Satchel.app"
