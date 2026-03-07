import { FaceLandmarker, FilesetResolver } from "./lib/vision_bundle.mjs";

// ─── State ───

let running = false;
let faceLandmarker = null;
let videoStream = null;
let port = null;

// Blink transition detection (hysteresis)
let eyesClosed = false;
const BLINK_CLOSE_THRESHOLD = 0.45;
const BLINK_OPEN_THRESHOLD = 0.25;

// ─── Status Reporting ───

function sendStatus(status, message) {
  try {
    chrome.runtime.sendMessage({ type: "status", status, message });
  } catch {}
}

// ─── Gaze Estimation from Blendshapes ───
// Uses ARKit-compatible blendshapes from MediaPipe FaceLandmarker.
// eyeLookIn/Out/Up/Down for each eye give us gaze direction.

function computeGaze(categories) {
  const get = (name) => {
    const item = categories.find((c) => c.categoryName === name);
    return item ? item.score : 0;
  };

  // Horizontal: positive = looking right, negative = looking left
  // "LookIn" on the left eye means looking toward nose = looking right
  // "LookOut" on the left eye means looking toward left ear = looking left
  const lookRight = (get("eyeLookInLeft") + get("eyeLookOutRight")) / 2;
  const lookLeft = (get("eyeLookOutLeft") + get("eyeLookInRight")) / 2;
  const horizontal = lookRight - lookLeft;

  // Vertical: positive = looking down, negative = looking up
  const lookDown = (get("eyeLookDownLeft") + get("eyeLookDownRight")) / 2;
  const lookUp = (get("eyeLookUpLeft") + get("eyeLookUpRight")) / 2;
  const vertical = lookDown - lookUp;

  return { horizontal, vertical };
}

// ─── Blink Detection ───
// Uses hysteresis to detect complete blink cycles (close then open).
// Returns true only on the open transition after a close.

function detectBlink(categories) {
  const get = (name) => {
    const item = categories.find((c) => c.categoryName === name);
    return item ? item.score : 0;
  };

  const avgBlink = (get("eyeBlinkLeft") + get("eyeBlinkRight")) / 2;

  let blinkDetected = false;

  if (!eyesClosed && avgBlink > BLINK_CLOSE_THRESHOLD) {
    eyesClosed = true;
  } else if (eyesClosed && avgBlink < BLINK_OPEN_THRESHOLD) {
    eyesClosed = false;
    blinkDetected = true;
  }

  return blinkDetected;
}

// ─── Frame Processing Loop ───

function processFrame(video) {
  if (!running || !faceLandmarker || !port) return;

  try {
    const result = faceLandmarker.detectForVideo(video, performance.now());

    if (!result.faceBlendshapes || result.faceBlendshapes.length === 0) {
      port.postMessage({ type: "gaze-data", faceDetected: false });
      scheduleNextFrame(video);
      return;
    }

    const categories = result.faceBlendshapes[0].categories;
    const { horizontal, vertical } = computeGaze(categories);
    const blink = detectBlink(categories);

    port.postMessage({
      type: "gaze-data",
      faceDetected: true,
      horizontal,
      vertical,
      blink
    });
  } catch (err) {
    console.error("[EyesOnly:offscreen] Frame processing error:", err);
  }

  scheduleNextFrame(video);
}

function scheduleNextFrame(video) {
  if (!running) return;
  // Use setTimeout instead of requestAnimationFrame because offscreen
  // documents have no visible surface and rAF may not fire reliably.
  setTimeout(() => processFrame(video), 33); // ~30fps
}

// ─── Initialization ───

async function start() {
  try {
    sendStatus("loading", "Loading eye tracker...");

    // Resolve WASM fileset from local extension files
    const wasmPath = chrome.runtime.getURL("lib/wasm");
    const modelPath = chrome.runtime.getURL("models/face_landmarker.task");

    const vision = await FilesetResolver.forVisionTasks(wasmPath);

    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: modelPath,
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false
    });

    sendStatus("camera", "Opening camera...");

    videoStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" }
    });

    const video = document.createElement("video");
    video.srcObject = videoStream;
    video.setAttribute("playsinline", "");
    await video.play();

    // Wait for video to be ready for processing
    await new Promise((resolve) => {
      if (video.readyState >= 2) resolve();
      else video.addEventListener("loadeddata", resolve, { once: true });
    });

    // Connect streaming port to service worker
    port = chrome.runtime.connect({ name: "gaze-stream" });
    port.onDisconnect.addListener(() => {
      port = null;
      stop();
    });

    running = true;
    sendStatus("active", "Tracking active");
    processFrame(video);
  } catch (err) {
    const message =
      err.name === "NotAllowedError"
        ? "Camera permission denied"
        : err.name === "NotFoundError"
          ? "No camera found"
          : "Error: " + err.message;
    sendStatus("error", message);
    console.error("[EyesOnly:offscreen] Start failed:", err);
  }
}

function stop() {
  running = false;
  if (videoStream) {
    videoStream.getTracks().forEach((t) => t.stop());
    videoStream = null;
  }
  if (port) {
    try { port.disconnect(); } catch {}
    port = null;
  }
}

// Listen for stop command from service worker
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "stop-camera") {
    stop();
    sendResponse({ ok: true });
  }
});

// Auto-start when the offscreen document is created
start();
