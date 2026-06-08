#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Notesci's Linux app expects the custom Debian layout under /opt/notesci:
#   /opt/notesci/bin/notesci
#   /opt/notesci/backend
#   /opt/notesci/frontend
#   /opt/notesci/wheels
# plus Debian maintainer scripts that create the offline Python venv and
# provision the system PostgreSQL database.
#
# A raw `cargo tauri build --bundles deb` package is not installable for the
# production Linux layout because it only contains the Tauri binary and bundled
# resources. Always delegate local Debian builds to the project packager.
if [[ $# -gt 0 ]]; then
  exec "$ROOT_DIR/packaging/build-deb.sh" "$@"
fi

exec "$ROOT_DIR/packaging/build-deb.sh"
