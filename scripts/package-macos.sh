#!/bin/bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
output=${1:?Pass an output directory}
version=45.3.2
archive="electron-v${version}-darwin-arm64.zip"
digest=8bdf5d55fbcc2c348b5d34b9e87a364cd2947d00b7c8bfadc6cc50233cd79ac6
scratch=$(mktemp -d "${TMPDIR:-/tmp}/activity-desk-package.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT

curl --fail --location --silent --show-error --retry 3 \
  "https://github.com/electron/electron/releases/download/v${version}/${archive}" -o "$scratch/$archive"
printf '%s  %s\n' "$digest" "$scratch/$archive" | shasum -a 256 -c -
ditto -x -k "$scratch/$archive" "$scratch/unpacked"
app="$scratch/unpacked/Electron.app"
test -x "$app/Contents/MacOS/Electron"
cp "$root/Activity Desk.app/Contents/Info.plist" "$app/Contents/Info.plist"
payload="Activity Desk.app/Contents/Resources/app"
git -C "$root" ls-files -z -- "$payload/" | while IFS= read -r -d '' source; do
  destination="$scratch/payload/${source#"$payload/"}"
  mkdir -p "$(dirname "$destination")"
  cp "$root/$source" "$destination"
done
test -f "$scratch/payload/package.json"
tools="$root/scripts/electron-package"
npm --prefix "$tools" ci --ignore-scripts --no-audit --no-fund
node "$tools/macos.mjs" pack "$app" "$scratch/payload"
mkdir -p "$output"
mv "$app" "$scratch/unpacked/Activity Desk.app"
ditto -c -k --sequesterRsrc --keepParent "$scratch/unpacked/Activity Desk.app" "$output/Activity-Desk-macos-arm64.zip"
(cd "$output" && shasum -a 256 Activity-Desk-macos-arm64.zip > Activity-Desk-macos-arm64.zip.sha256)
