#!/bin/sh
# Runs before the image renders its templates (ADR-0075, #524).
#
# `PANEL_STORAGE_UPLOAD_ORIGIN` goes into the panel's CSP `connect-src`, so it
# must be exactly one https origin: a scheme, a host and an optional port.
# Anything else, such as a path, a second origin or a `;`, could widen the
# policy past what ADR-0075 allows, so the container refuses to start.
set -eu

origin="${PANEL_STORAGE_UPLOAD_ORIGIN:-}"

if [ -z "$origin" ]; then
  exit 0
fi

if ! printf '%s' "$origin" | grep -Eq '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'; then
  echo "PANEL_STORAGE_UPLOAD_ORIGIN must be one https origin (https://host or https://host:port, lower case)." >&2
  exit 1
fi
