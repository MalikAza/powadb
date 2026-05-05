#!/usr/bin/env bash
# Post-bundle: flag .VolumeIcon.icns invisible inside the built DMG so it
# doesn't appear next to the app and Applications shortcut in Finder.
set -euo pipefail

DMG_DIR="$(cd "$(dirname "$0")/../src-tauri/target/release/bundle/dmg" && pwd)"

shopt -s nullglob
dmgs=("$DMG_DIR"/*.dmg)
if [ ${#dmgs[@]} -eq 0 ]; then
  echo "No DMG found in $DMG_DIR" >&2
  exit 1
fi

for dmg in "${dmgs[@]}"; do
  echo "Patching $(basename "$dmg")"

  rw_dmg="${dmg%.dmg}.rw.dmg"
  hdiutil convert "$dmg" -format UDRW -o "$rw_dmg" -ov >/dev/null

  mount_output="$(hdiutil attach -nobrowse -noautoopen "$rw_dmg")"
  mount_point="$(echo "$mount_output" | awk -F'\t' '/\/Volumes\// {print $NF; exit}')"

  if [ -z "$mount_point" ] || [ ! -d "$mount_point" ]; then
    echo "Failed to mount $rw_dmg" >&2
    exit 1
  fi

  icon="$mount_point/.VolumeIcon.icns"
  if [ -f "$icon" ]; then
    rm -f "$icon"
    SetFile -a c "$mount_point" 2>/dev/null || true
    echo "  removed $icon"
  else
    echo "  no .VolumeIcon.icns inside, skipping"
  fi

  hdiutil detach "$mount_point" >/dev/null
  hdiutil convert "$rw_dmg" -format UDZO -imagekey zlib-level=9 -o "$dmg" -ov >/dev/null
  rm -f "$rw_dmg"
done

echo "Done."
