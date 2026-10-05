#!/usr/bin/env bash
# Build, render every mockup, then render the before/after sheet from the fresh PNGs.
set -e
cd "$(dirname "$0")"
npx vite build >/dev/null
node render.mjs
mkdir -p public/after && cp out/B-today-*-1440.png out/E-gallery-1440.png public/after/
npx vite build >/dev/null
node render.mjs H-before
