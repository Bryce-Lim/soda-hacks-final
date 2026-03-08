const card = document.getElementById("card");
const activateBtn = document.getElementById("activateBtn");
const deactivateBtn = document.getElementById("deactivateBtn");
const zoomBtn = document.getElementById("zoomBtn");

function showState(tracking, zoomed) {
  card.classList.toggle("active", tracking);

  activateBtn.classList.toggle("visible", !tracking);
  deactivateBtn.classList.toggle("visible", tracking);
  zoomBtn.classList.toggle("visible", tracking);

  if (zoomed) {
    zoomBtn.textContent = "Undo Zoom";
    zoomBtn.classList.remove("btn-filled");
    zoomBtn.classList.add("btn-outlined");
  } else {
    zoomBtn.textContent = "Zoom";
    zoomBtn.classList.remove("btn-outlined");
    zoomBtn.classList.add("btn-filled");
  }
}

async function ensureCameraPermission() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera API not available in this browser context");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  stream.getTracks().forEach((t) => t.stop());
}

activateBtn.addEventListener("click", async () => {
  activateBtn.disabled = true;

  try {
    await ensureCameraPermission();

    const response = await chrome.runtime.sendMessage({
      type: "start-tracking",
      settings: {
        sensitivity: 1.0,
        smoothing: 0.06
      }
    });

    if (response?.error) {
      activateBtn.disabled = false;
    } else {
      showState(true, false);
    }
  } catch {
    activateBtn.disabled = false;
  }
});

deactivateBtn.addEventListener("click", async () => {
  deactivateBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "stop-tracking" });
  } catch {}
  showState(false, false);
  activateBtn.disabled = false;
  deactivateBtn.disabled = false;
});

zoomBtn.addEventListener("click", async () => {
  zoomBtn.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({ type: "toggle-easy-click-mode" });
    if (response?.ok) {
      showState(true, !!response.enabled);
    }
  } catch {}

  zoomBtn.disabled = false;
});

// Sync UI with current state when popup opens
chrome.runtime.sendMessage({ type: "get-status" }, (response) => {
  if (chrome.runtime.lastError) return;
  if (!response) return;

  showState(!!response.tracking, !!response.easyClickMode);
});

// Start in inactive state
showState(false, false);
