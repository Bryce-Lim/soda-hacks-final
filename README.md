# 👀 Sightline

<img width="426" height="299" alt="image" src="https://github.com/user-attachments/assets/0bfa2c7e-0583-410d-ab51-7a33d1a3537e" />

## 💡 Inspiration
Some people can't use their hands to control a mouse. There are various neurological and physical conditions that can cause significant motor control impairment, including full body paralysis. It is difficult or impossible for these people to use a mouse to navigate webpages, or even use voice control tools.

## 🧠 Solution
We created a chrome extension that allows you to navigate through any webpage with just your eyes. Once activated, it creates an embedded cursor which moves wherever your eyes look (using your camera to track your eyes). When you blink, you click on wherever you are looking.

## 🤖 WebEyeTrack ML
We use a SOTA ML model developed in a recent research paper (https://arxiv.org/abs/2508.19544) that uses a multilayer perceptron neural network to process eye movement and make gaze predictions. This performs better than traditional methods like WebGazer.

## ➡️ Running
1) Download the whole project
2) Go to chrome://extensions
3) Turn on developer mode
4) Click load unpacked, and select this whole folder

Then you can activate the extension whenever you want!

## Quick Start

```bash
# 1. Run setup (installs WebEyeTrack + downloads model assets)
bash setup.sh

# 2. Load in Chrome
#    - Go to chrome://extensions
#    - Enable "Developer mode"
#    - Click "Load unpacked" and select this directory

# 3. Use it
#    - Navigate to any webpage
#    - Click the Sightline extension icon
#    - Press "Activate"
#    - Allow camera access when prompted
#    - Move your eyes to control the cursor
#    - Long blink (200ms+) to click
```

## Tech Stack & Implementation

### Platform

**Chrome Extension (Manifest V3)** — uses the modern MV3 architecture with a service worker instead of a persistent background page. All code is vanilla JavaScript, no build step or framework.

### Architecture

```
Popup (UI)  →  Service Worker (orchestrator)  →  Offscreen Document (webcam + ML)
                        ↓
                Content Script (cursor + clicks)
```

Four components communicate via Chrome's messaging APIs:

### 1. Offscreen Document (`offscreen.js` + `offscreen.html`)

- **Why offscreen?** MV3 service workers can't access the DOM or webcam. The offscreen document is a hidden page with full DOM/media access.
- Opens the webcam via `getUserMedia`, draws frames to a `<canvas>`, and feeds `ImageData` into **WebEyeTrack** ~30fps (`33ms` intervals).
- **WebEyeTrack** (`lib/webeyetrack.js`) is a gaze estimation library built on **MediaPipe Face Landmarker** (`models/face_landmarker.task`) with WASM backends (`lib/wasm/`). It returns:
  - `normPog` — normalized point-of-gaze (horizontal/vertical, roughly -0.5 to 0.5)
  - `gazeState` — `"open"` or `"closed"` (eye state)
- Detects blinks via state transitions (open→closed→open) and streams `gaze-data` messages over a **Chrome port** (`"gaze-stream"`) to the service worker.

### 2. Service Worker (`service_worker.js`)

- **Orchestrator** — no ML or DOM, just message routing and state management.
- On `start-tracking`: connects a port to the content script, creates the offscreen document.
- **Relays** every `gaze-data` message from the offscreen port to the content script port.
- Handles tab switching (`tabs.onActivated`) — disconnects old tab, connects to new one, so tracking follows the user across tabs.
- Handles tab navigation (`tabs.onUpdated`) — reconnects when a page reloads.
- Manages **Easy Click Mode** — uses `chrome.tabs.setZoom()` to zoom to 1.8x and restores previous zoom on disable.

### 3. Content Script (`content_script.js`)

Injected on every page (`"<all_urls>"`, `document_idle`). Does all the visual and interaction work:

**Cursor overlay** — a 50px semi-transparent grey circle (`position: fixed`, max z-index, `pointer-events: none`). Flashes orange (`#F65009`) on click.

**Gaze → screen mapping pipeline:**

1. **Input smoothing** — EMA filter (`INPUT_GAZE_ALPHA = 0.12`) on raw horizontal/vertical values
2. **Bias learning** — slowly learns neutral gaze center to auto-correct drift
3. **Deadzone** — ignores small movements (X: 0.15, Y: 0.07)
4. **Response shaping** — power curve (`responseExponent`) for natural feel
5. **Axis mapping** — maps normalized gaze to -1..1 with per-axis gain. Vertical uses an adaptive envelope that tracks the user's personal up/down range.
6. **Sensitivity scaling** — multiplies mapped values by user sensitivity (default 1x)
7. **Adaptive smoothing** — lower alpha when fixating (stable), higher when moving (responsive)
8. **Stillness lock** — if cursor moves <1.5px for 4 frames, it freezes completely

**Blink-to-click:**

- Tracks `eyesClosedAt` timestamp when eyes close
- Only triggers a click if eyes were closed ≥200ms (filters natural blinks ~100-150ms)
- 600ms cooldown between clicks
- Uses `findClickableNear` (70px radius, 9 probe points) to find the nearest interactive element, walking up the DOM for clickable ancestors
- Calls native `.click()` on the element (or its `<a>` ancestor for links)

**Edge scrolling:**

- When cursor enters a 60px edge zone, scrolls in that direction
- Finds the scrollable container under the cursor (`overflow: auto/scroll`) so nested scroll areas (PDFs, chat panels) work
- Caches last scroll target so scrolling up still works when `elementFromPoint` misses

**Status badge** — small white pill with orange border in the bottom-right showing state ("Tracking", "Clicked!", "No face detected").

### 4. Popup (`popup.html/css/js`)

- Minimal UI matching the Sightline design — white card, orange accent (`#F65009`), Inter font.
- Three states: Inactive (Activate button), Active (Deactivate + Zoom), Active+Zoomed (Deactivate + Undo Zoom).
- Communicates with service worker via one-shot `chrome.runtime.sendMessage`.

### Dependencies

- **WebEyeTrack** (npm package, bundled locally) — webcam gaze estimation
- **MediaPipe Face Landmarker** (WASM + task file) — face/eye landmark detection, runs on CPU via XNNPACK delegate
- No other runtime dependencies. No React, no build tools, no bundler.

## File Structure

```
manifest.json         Chrome extension manifest (MV3)
popup.html/css/js     Extension popup UI
service_worker.js     Background service worker
content_script.js     Page overlay + cursor + click handling
offscreen.html/js     Webcam + MediaPipe processing
setup.sh              Downloads dependencies
lib/                  WebEyeTrack browser bundle (created by setup.sh)
  webeyetrack.js
  wasm/               MediaPipe WASM backends
models/               Face landmarker model
```

## Controls

| Control | Description |
|---------|-------------|
| Activate | Begins webcam capture and eye tracking |
| Deactivate | Stops tracking, removes cursor, releases camera |
| Zoom | Enables Easy Click Mode (1.8x browser zoom) |
| Undo Zoom | Disables Easy Click Mode, restores original zoom |

## Requirements

- Chrome 116+ (for offscreen document API)
- Webcam
- Node.js / npm (for setup only)

## Limitations

- Gaze accuracy is approximate — works best for clicking large UI elements
- Cannot work on chrome:// pages or the Chrome Web Store
- Camera must have reasonable lighting
- Single face only; multiple faces may cause erratic behavior
- Webcam-only gaze tracking accuracy varies by camera placement and lighting
- No drag, double-click, or right-click support
