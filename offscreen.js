// State
let running = false;
let tracker = null;
let video = null;
let stream = null;
let port = null;
let eyesClosed = false;
let frameTimer = null;
let canvas = null;
let ctx = null;

const FRAME_MS = 33;

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

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function emitNoFace() {
  if (!running || !port) return;
  port.postMessage({ type: "gaze-data", faceDetected: false });
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


function stopFrameLoop() {
  if (frameTimer) {
    clearTimeout(frameTimer);
    frameTimer = null;
  }
}

async function processFrame() {
  if (!running || !tracker || !video || !ctx || !canvas || !port) return;
  try {
    if (video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
      emitNoFace();
      scheduleNextFrame();
      return;
    }

    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result = await tracker.step(frame, performance.now());

    if (!result || !result.facialLandmarks || result.facialLandmarks.length === 0) {
      emitNoFace();
      scheduleNextFrame();
      return;
    }

    const normPog = Array.isArray(result.normPog) ? result.normPog : [0, 0];
    const horizontal = clamp(normPog[0], -0.5, 0.5);
    const vertical = clamp(normPog[1], -0.5, 0.5);

    const nowClosed = result.gazeState === "closed";
    let blinkDetected = false;
    if (!eyesClosed && nowClosed) {
      eyesClosed = true;
    } else if (eyesClosed && !nowClosed) {
      eyesClosed = false;
      blinkDetected = true;
    }

    port.postMessage({
      type: "gaze-data",
      faceDetected: true,
      horizontal,
      vertical,
      blink: blinkDetected,
      eyesClosed,
      blinkScore: nowClosed ? 1 : 0
    });
  } catch (err) {
    console.error("[EyesOnly:offscreen] Frame processing error:", err);
    sendStatus("error", `Frame processing failed. ${formatError(err)}`);
    stop();
    return;
  }

  scheduleNextFrame();
}

function scheduleNextFrame() {
  if (!running) return;
  frameTimer = setTimeout(() => {
    processFrame().catch((err) => {
      sendStatus("error", `Frame loop crashed. ${formatError(err)}`);
      stop();
    });
  }, FRAME_MS);
}

async function start() {
  let stage = "initialization";
  try {
    sendStatus("loading", "Loading eye tracker...");

    stage = "checking runtime";
    if (!window.WebEyeTrack) {
      throw new Error("WebEyeTrack runtime not found");
    }

    stage = "connecting gaze stream";
    port = chrome.runtime.connect({ name: "gaze-stream" });
    port.onDisconnect.addListener(() => {
      port = null;
      stop();
    });

    stage = "opening camera";
    stream = await openCameraStream();
    video = document.getElementById("webcam");
    if (!video) {
      throw new Error("Hidden video element not found");
    }
    video.srcObject = stream;
    video.muted = true;
    video.setAttribute("playsinline", "");
    await video.play();

    stage = "initializing model";
    tracker = new window.WebEyeTrack();
    await tracker.initialize();

    stage = "preparing frame buffer";
    canvas = document.createElement("canvas");
    ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("Could not create 2D canvas context");
    }

    running = true;
    eyesClosed = false;
    sendStatus("active", "Tracking active");
    scheduleNextFrame();
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
    console.error(`[EyesOnly:offscreen] Start failed at ${stage}: ${formatError(err)}`);
    stop();
  }
}

function stop() {
  running = false;
  eyesClosed = false;
  stopFrameLoop();

  if (video) {
    try {
      video.pause();
    } catch {}
    try {
      video.srcObject = null;
    } catch {}
  }
  video = null;

  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  tracker = null;
  canvas = null;
  ctx = null;

  if (port) {
    try {
      port.disconnect();
    } catch {}
    port = null;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "stop-camera") {
    stop();
    sendResponse({ ok: true });
  }
});

start();
