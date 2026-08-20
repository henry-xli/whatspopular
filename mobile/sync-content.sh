#!/bin/sh
set -eu

MOBILE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$MOBILE_DIR/.." && pwd)

cp "$PROJECT_DIR/website/data/trends.json" "$MOBILE_DIR/BundleData/trends.json"
mkdir -p "$MOBILE_DIR/BundleData/culture"
cp "$PROJECT_DIR"/website/public/culture/*.webp "$MOBILE_DIR/BundleData/culture/"

printf '%s\n' "Synced the website briefing and local culture images into mobile/Resources."
