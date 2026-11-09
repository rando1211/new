#!/usr/bin/env bash
# Copy the zero-dependency core into the skill so the skill stays in sync with src/.
set -euo pipefail
cd "$(dirname "$0")"
dest=skill/pii-shield/scripts
for f in detectors.js vault.js shield.js cli.js; do cp "src/$f" "$dest/$f"; done
printf '{ "type": "module" }\n' > "$dest/package.json"
echo "skill scripts updated in $dest"
