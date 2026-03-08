const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const calibrateBtn = document.getElementById("calibrateBtn");
const easyClickBtn = document.getElementById("easyClickBtn");
const statusEl = document.getElementById("status");
const sensitivityEl = document.getElementById("sensitivity");
const sensitivityValueEl = document.getElementById("sensitivityValue");
const smoothingEl = document.getElementById("smoothing");
const smoothingValueEl = document.getElementById("smoothingValue");

function setEasyClickButton(enabled) {
  easyClickBtn.textContent = enabled ? "Disable Easy Click Mode" : "Enable Easy Click Mode";
}

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
      easyClickBtn.disabled = false;
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
  easyClickBtn.disabled = true;
  setEasyClickButton(false);
});

calibrateBtn.addEventListener("click", async () => {
  calibrateBtn.disabled = true;
  setStatus("Running 5-point calibration...");

  try {
    const response = await chrome.runtime.sendMessage({ type: "run-calibration" });
    if (response?.ok) {
      setStatus("Follow on-screen calibration points");
    } else {
      setStatus("Error: " + (response?.error || "Calibration failed"));
    }
  } catch (err) {
    setStatus("Error: " + err.message);
  } finally {
    // Keep enabled while tracking so user can recalibrate anytime.
    chrome.runtime.sendMessage({ type: "get-status" }, (response) => {
      calibrateBtn.disabled = !response?.tracking;
      easyClickBtn.disabled = !response?.tracking;
      setEasyClickButton(!!response?.easyClickMode);
    });
  }
});

easyClickBtn.addEventListener("click", async () => {
  easyClickBtn.disabled = true;
  setStatus("Updating Easy Click Mode...");

  try {
    const response = await chrome.runtime.sendMessage({ type: "toggle-easy-click-mode" });
    if (response?.ok) {
      setEasyClickButton(!!response.enabled);
      setStatus(response.enabled ? "Easy Click Mode enabled" : "Easy Click Mode disabled");
    } else {
      setStatus("Error: " + (response?.error || "Could not toggle mode"));
    }
  } catch (err) {
    setStatus("Error: " + err.message);
  } finally {
    chrome.runtime.sendMessage({ type: "get-status" }, (response) => {
      easyClickBtn.disabled = !response?.tracking;
      setEasyClickButton(!!response?.easyClickMode);
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
    easyClickBtn.disabled = false;
    setStatus(response.statusMessage || "Eye tracking active");
  } else {
    setEasyClickButton(false);
  }

  if (response.sensitivity) {
    sensitivityEl.value = response.sensitivity;
    sensitivityValueEl.textContent = response.sensitivity + "x";
  }
  if (response.smoothing) {
    smoothingEl.value = response.smoothing;
    smoothingValueEl.textContent = String(response.smoothing);
  }
  setEasyClickButton(!!response.easyClickMode);
});
