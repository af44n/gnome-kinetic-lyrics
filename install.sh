#!/usr/bin/env bash
# Build and install Kinetic Lyrics for the current user.
set -euo pipefail
cd "$(dirname "$0")"

UUID="kinetic-lyrics@af44n"

glib-compile-schemas schemas/
mkdir -p build   # gnome-extensions pack crashes if the output dir is missing
gnome-extensions pack --force \
    --extra-source=lyricsClient.js \
    --extra-source=fonts \
    --extra-source=LICENSE \
    --out-dir=build .
gnome-extensions install --force "build/${UUID}.shell-extension.zip"

if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "Kinetic Lyrics installed and enabled."
else
    echo "Kinetic Lyrics installed."
    echo "On Wayland, log out and back in, then run:  gnome-extensions enable $UUID"
fi
