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

# Install MediaPipe tasks-vision
echo "Installing @mediapipe/tasks-vision..."
npm install @mediapipe/tasks-vision

# Create output directories
mkdir -p lib/wasm models

# Copy the vision bundle (ESM entry point)
echo "Copying MediaPipe library files..."
if [ -f "node_modules/@mediapipe/tasks-vision/vision_bundle.mjs" ]; then
  cp node_modules/@mediapipe/tasks-vision/vision_bundle.mjs lib/vision_bundle.mjs
else
  echo "ERROR: vision_bundle.mjs not found in @mediapipe/tasks-vision package."
  echo "The package structure may have changed. Check node_modules/@mediapipe/tasks-vision/"
  exit 1
fi

# Copy all WASM files (includes SIMD and non-SIMD variants)
cp node_modules/@mediapipe/tasks-vision/wasm/* lib/wasm/

echo "Library files copied to lib/"

# Download face landmarker model
echo ""
echo "Downloading face landmarker model (~5MB)..."
curl -L --progress-bar -o models/face_landmarker.task \
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task"

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
