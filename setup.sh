#!/bin/bash
set -e

echo "=== Eyes Only - Setup ==="
echo ""

# Check for npm
if ! command -v npm &> /dev/null; then
  echo "ERROR: npm is required. Install Node.js first: https://nodejs.org"
  exit 1
fi

# Check for curl
if ! command -v curl &> /dev/null; then
  echo "ERROR: curl is required."
  exit 1
fi

# Initialize npm project if needed
if [ ! -f "package.json" ]; then
  echo "Initializing npm project..."
  npm init -y > /dev/null 2>&1
fi

# Install WebEyeTrack runtime
echo "Installing webeyetrack..."
npm install webeyetrack

# Create output directories
mkdir -p lib web

# Copy WebEyeTrack bundle
echo "Copying WebEyeTrack bundle..."
if [ -f "node_modules/webeyetrack/dist/index.js" ]; then
  cp node_modules/webeyetrack/dist/index.js lib/webeyetrack.js
else
  echo "ERROR: dist/index.js not found in webeyetrack package."
  exit 1
fi

# Patch upstream hardcoded CDN paths to local extension assets (CSP-safe).
node - <<'NODE'
const fs = require("fs");
const path = "lib/webeyetrack.js";
let src = fs.readFileSync(path, "utf8");
src = src.replace(
  /https:\/\/cdn\.jsdelivr\.net\/npm\/@mediapipe\/tasks-vision@0\.10\.3\/wasm/g,
  "/lib/wasm"
);
src = src.replace(
  /https:\/\/storage\.googleapis\.com\/mediapipe-models\/face_landmarker\/face_landmarker\/float16\/1\/face_landmarker\.task/g,
  "/models/face_landmarker.task"
);
fs.writeFileSync(path, src, "utf8");
NODE

# Download WebEyeTrack model assets expected at /web/model.json
echo "Downloading WebEyeTrack model assets..."
curl -L --progress-bar -o web/model.json \
  "https://raw.githubusercontent.com/RedForestAI/WebEyeTrack/main/js/examples/minimal-example/public/web/model.json"
curl -L --progress-bar -o web/group1-shard1of1.bin \
  "https://raw.githubusercontent.com/RedForestAI/WebEyeTrack/main/js/examples/minimal-example/public/web/group1-shard1of1.bin"

echo ""
echo "=== Setup complete! ==="
echo ""
echo "To load the extension in Chrome:"
echo "  1. Open chrome://extensions"
echo "  2. Enable 'Developer mode' (top right toggle)"
echo "  3. Click 'Load unpacked'"
echo "  4. Select this directory: $(pwd)"
echo "  5. Navigate to any webpage"
echo "  6. Click the Eyes Only icon and press 'Start Eye Control'"
echo ""
echo "Note: Allow camera access when prompted."
