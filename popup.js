const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const calibrateBtn = document.getElementById("calibrateBtn");
const statusEl = document.getElementById("status");
const sensitivityEl = document.getElementById("sensitivity");
const sensitivityValueEl = document.getElementById("sensitivityValue");
const smoothingEl = document.getElementById("smoothing");
const smoothingValueEl = document.getElementById("smoothingValue");

function setStatus(text) {
  statusEl.textContent = text;
}

async function ensureCameraPermission() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera API not available in this browser context");
  }

  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  stream.getTracks().forEach((t) => t.stop());
}

// Send settings changes live while tracking
sensitivityEl.addEventListener("input", () => {
  sensitivityValueEl.textContent = sensitivityEl.value + "x";
  chrome.runtime.sendMessage({
    type: "update-settings",
    settings: { sensitivity: parseFloat(sensitivityEl.value) }
  });
});

smoothingEl.addEventListener("input", () => {
  smoothingValueEl.textContent = smoothingEl.value;
  chrome.runtime.sendMessage({
    type: "update-settings",
    settings: { smoothing: parseFloat(smoothingEl.value) }
  });
});

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  setStatus("Starting...");

  try {
    setStatus("Requesting camera permission...");
    await ensureCameraPermission();

    const response = await chrome.runtime.sendMessage({
      type: "start-tracking",
      settings: {
        sensitivity: parseFloat(sensitivityEl.value),
        smoothing: parseFloat(smoothingEl.value)
      }
    });

    if (response?.error) {
      setStatus("Error: " + response.error);
      startBtn.disabled = false;
    } else {
      setStatus("Eye tracking active");
      stopBtn.disabled = false;
      calibrateBtn.disabled = false;
    }
  } catch (err) {
    const message =
      err?.name === "NotAllowedError"
        ? "Camera permission denied or dismissed. Allow camera and try again."
        : "Error: " + err.message;
    setStatus(message);
    startBtn.disabled = false;
  }
});

stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "stop-tracking" });
  } catch {}
  setStatus("Stopped");
  startBtn.disabled = false;
  calibrateBtn.disabled = true;
});

calibrateBtn.addEventListener("click", async () => {
  calibrateBtn.disabled = true;
  setStatus("Calibrating center...");

  try {
    const response = await chrome.runtime.sendMessage({ type: "calibrate-center" });
    if (response?.ok) {
      setStatus("Center calibrated");
    } else {
      setStatus("Error: " + (response?.error || "Calibration failed"));
    }
  } catch (err) {
    setStatus("Error: " + err.message);
  } finally {
    // Keep enabled while tracking so user can recalibrate anytime.
    chrome.runtime.sendMessage({ type: "get-status" }, (response) => {
      calibrateBtn.disabled = !response?.tracking;
    });
  }
});

// Sync UI with current state when popup opens
chrome.runtime.sendMessage({ type: "get-status" }, (response) => {
  if (chrome.runtime.lastError) return;
  if (!response) return;

  if (response.tracking) {
    startBtn.disabled = true;
    stopBtn.disabled = false;
    calibrateBtn.disabled = false;
    setStatus(response.statusMessage || "Eye tracking active");
  }

  if (response.sensitivity) {
    sensitivityEl.value = response.sensitivity;
    sensitivityValueEl.textContent = response.sensitivity + "x";
  }
  if (response.smoothing) {
    smoothingEl.value = response.smoothing;
    smoothingValueEl.textContent = String(response.smoothing);
  }
});
