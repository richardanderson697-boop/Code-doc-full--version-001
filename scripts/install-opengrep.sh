#!/bin/sh
# Installs the pinned Opengrep engine binary into ./bin/opengrep.
# Idempotent: skips when the pinned version is already installed.
# Never fails the enclosing npm install: without the binary the PreFlight
# scan simply runs on the vendored engine only (see server/preflight/opengrep/runner.ts).
set -u

VERSION="1.30.0"
DEST="bin/opengrep"

if [ -x "$DEST" ]; then
  INSTALLED="$("$DEST" --version 2>/dev/null || true)"
  if [ "$INSTALLED" = "$VERSION" ]; then
    echo "opengrep $VERSION already installed"
    exit 0
  fi
fi

ARCH="$(uname -m 2>/dev/null || echo unknown)"
case "$ARCH" in
  x86_64) ASSET="opengrep_manylinux_x86" ;;
  aarch64|arm64) ASSET="opengrep_manylinux_aarch64" ;;
  *)
    echo "warning: unsupported arch '$ARCH' for opengrep binary; skipping (PreFlight works without it)"
    exit 0
    ;;
esac

mkdir -p bin
if curl -sSL --max-time 300 -o "$DEST" "https://github.com/opengrep/opengrep/releases/download/v${VERSION}/${ASSET}"; then
  chmod +x "$DEST"
  echo "opengrep $("$DEST" --version 2>/dev/null || echo installed)"
else
  echo "warning: opengrep download failed; continuing without it (PreFlight works without it)"
fi
exit 0
