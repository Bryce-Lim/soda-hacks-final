# Eyes Only - Eye Tracking Web Navigation

A Chrome extension that lets you control the browser with your eyes. Gaze moves a visible cursor overlay, blinking triggers a click.

Built as an accessibility tool for users with severe motor impairments.

## Quick Start

```bash
# 1. Run setup (installs MediaPipe + downloads model)
bash setup.sh

# 2. Load in Chrome
#    - Go to chrome://extensions
#    - Enable "Developer mode"
#    - Click "Load unpacked" and select this directory

# 3. Use it
#    - Navigate to any webpage
#    - Click the Eyes Only extension icon
#    - Press "Start Eye Control"
#    - Allow camera access when prompted
#    - Move your eyes to control the cursor
#    - Blink to click
```

## How It Works

### Architecture

```
Popup (UI)  -->  Service Worker (relay)  -->  Offscreen Document (webcam + ML)
                       |
                       v
               Content Script (cursor overlay + click handling)
```

### Components

- **Offscreen Document** (`offscreen.js`): Runs the webcam and MediaPipe FaceLandmarker in a hidden document. Extracts face blendshapes at ~30fps and streams gaze direction + blink events to the service worker via a chrome port.

- **Service Worker** (`service_worker.js`): Orchestrates everything. Creates/destroys the offscreen document, connects to the content script, and relays gaze data between them.

- **Content Script** (`content_script.js`): Renders a visible cursor overlay on the active tab. Applies exponential moving average smoothing to reduce jitter. On blink, finds the clickable element under the cursor (walking up the DOM tree) and dispatches mouse events.

- **Popup** (`popup.html/js`): Start/Stop controls plus sensitivity and smoothing sliders.

### Eye Tracking Approach

Uses **MediaPipe FaceLandmarker** with face blendshapes enabled. The ARKit-compatible blendshapes provide:

- `eyeLookInLeft/Right`, `eyeLookOutLeft/Right` for horizontal gaze direction
- `eyeLookUpLeft/Right`, `eyeLookDownLeft/Right` for vertical gaze direction
- `eyeBlinkLeft`, `eyeBlinkRight` for blink detection

Gaze blendshapes are mapped to screen coordinates using a sensitivity multiplier (adjustable via the popup). No explicit calibration step is needed.

Blink detection uses hysteresis (separate open/close thresholds) to detect complete blink cycles and avoid false positives.

## File Structure

```
manifest.json         Chrome extension manifest (MV3)
popup.html/css/js     Extension popup UI
service_worker.js     Background service worker
content_script.js     Page overlay + cursor + click handling
offscreen.html/js     Webcam + MediaPipe processing
setup.sh              Downloads dependencies
lib/                  MediaPipe library files (created by setup.sh)
  vision_bundle.mjs
  wasm/
models/               ML model (created by setup.sh)
  face_landmarker.task
```

## Controls

| Control | Description |
|---------|-------------|
| Start Eye Control | Begins webcam capture and eye tracking |
| Stop Eye Control | Stops tracking, removes cursor, releases camera |
| Sensitivity slider | How much eye movement maps to cursor movement (1x-5x) |
| Smoothing slider | Cursor smoothing amount (lower = smoother but more lag) |

## Requirements

- Chrome 116+ (for offscreen document API)
- Webcam
- Node.js / npm (for setup only)

## Limitations

- Gaze accuracy is approximate - works best for clicking large UI elements
- No scroll-by-gaze (use keyboard or other input for scrolling)
- Cursor only works on the tab that was active when tracking started
- Cannot work on chrome:// pages or the Chrome Web Store
- Camera must have reasonable lighting
- Single face only; multiple faces may cause erratic behavior
- Blink sensitivity may need tuning per person (adjust thresholds in offscreen.js)
- No drag, double-click, or right-click support
