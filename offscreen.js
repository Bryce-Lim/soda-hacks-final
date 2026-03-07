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

function formatError(err) {
  if (!err) return "Unknown error";
  const name = err.name || "Error";
  const message = err.message || String(err);
  return `${name}: ${message}`;
}

async function openCameraStream() {
  const constraintsList = [
    { video: { width: 640, height: 480, facingMode: "user" } },
    { video: { facingMode: "user" } },
    { video: true }
  ];

  let lastErr = null;
  for (const constraints of constraintsList) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new DOMException("Unable to access camera", "NotReadableError");
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

  return { blinkDetected, avgBlink, eyesClosed };
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
    const blinkState = detectBlink(categories);

    port.postMessage({
      type: "gaze-data",
      faceDetected: true,
      horizontal,
      vertical,
      blink: blinkState.blinkDetected,
      eyesClosed: blinkState.eyesClosed,
      blinkScore: blinkState.avgBlink
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
  let stage = "initialization";
  try {
    sendStatus("loading", "Loading eye tracker...");

    // Resolve WASM fileset from local extension files
    stage = "resolving wasm files";
    const wasmPath = chrome.runtime.getURL("lib/wasm");
    const modelPath = chrome.runtime.getURL("models/face_landmarker.task");

    stage = "loading vision tasks runtime";
    const vision = await FilesetResolver.forVisionTasks(wasmPath);

    stage = "creating face landmarker";
    // Try GPU first for lower latency, then fall back to CPU if GPU init fails.
    try {
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
    } catch (gpuErr) {
      console.warn("[EyesOnly:offscreen] GPU delegate unavailable, falling back to CPU:", gpuErr);
      faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: modelPath,
          delegate: "CPU"
        },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false
      });
    }

    sendStatus("camera", "Opening camera...");

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new DOMException("getUserMedia is not available in this context", "NotSupportedError");
    }

    stage = "requesting camera stream";
    videoStream = await openCameraStream();

    stage = "starting video playback";
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.srcObject = videoStream;
    video.setAttribute("playsinline", "");
    video.setAttribute("muted", "");
    await video.play();

    // Wait for video to be ready for processing
    stage = "waiting for video frames";
    await new Promise((resolve, reject) => {
      if (video.readyState >= 2) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        reject(new DOMException("Timed out waiting for video frames", "AbortError"));
      }, 5000);

      const onReady = () => {
        clearTimeout(timeout);
        resolve();
      };

      video.addEventListener("loadeddata", onReady, { once: true });
    });

    // Connect streaming port to service worker
    stage = "connecting gaze stream";
    port = chrome.runtime.connect({ name: "gaze-stream" });
    port.onDisconnect.addListener(() => {
      port = null;
      stop();
    });

    stage = "starting frame loop";
    running = true;
    sendStatus("active", "Tracking active");
    processFrame(video);
  } catch (err) {
    const name = err?.name || "";
    const reason =
      name === "NotAllowedError"
        ? "Camera permission denied"
        : name === "NotFoundError"
          ? "No camera found"
          : name === "NotReadableError"
            ? "Camera is busy or blocked by another app"
            : name === "SecurityError"
              ? "Camera access blocked by browser or OS policy"
              : "Startup failed";
    const message = `${reason} during ${stage}. ${formatError(err)}`;
    sendStatus("error", message);
    console.error(
      `[EyesOnly:offscreen] Start failed at ${stage}: ${formatError(err)}`
    );
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
