// ─── State ───

let state = {
  tracking: false,
  tabId: null,
  tabPort: null,      // port to content script
  gazePort: null,     // port from offscreen document
  statusMessage: "Ready",
  settings: {
    sensitivity: 2.5,
    smoothing: 0.15
  }
};

// ─── Offscreen Document Management ───

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Webcam access for eye tracking"
  });
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

// ─── Port from Offscreen Document (gaze data stream) ───

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "gaze-stream") return;

  state.gazePort = port;

  port.onMessage.addListener((msg) => {
    // Forward gaze data to the content script on the active tab
    if (state.tabPort && state.tracking) {
      try {
        state.tabPort.postMessage(msg);
      } catch {
        // Port may have disconnected
      }
    }
  });

  port.onDisconnect.addListener(() => {
    state.gazePort = null;
  });
});

// ─── Start / Stop Tracking ───

async function startTracking(settings) {
  if (state.tracking) return { error: "Already tracking" };

  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { error: "No active tab found" };

  // Verify content script is injected on this tab
  try {
    const pong = await chrome.tabs.sendMessage(tab.id, { type: "ping" });
    if (!pong?.ok) throw new Error();
  } catch {
    return { error: "Cannot connect to this page. Try refreshing." };
  }

  state.tabId = tab.id;
  state.settings = { ...state.settings, ...settings };

  // Connect to content script via port
  try {
    state.tabPort = chrome.tabs.connect(tab.id, { name: "gaze-stream" });
  } catch (err) {
    return { error: "Failed to connect to page: " + err.message };
  }

  state.tabPort.postMessage({
    type: "start-overlay",
    settings: state.settings
  });

  state.tabPort.onDisconnect.addListener(() => {
    state.tabPort = null;
    // If tab closed while tracking, clean up
    if (state.tracking) stopTracking();
  });

  // Create offscreen document (starts webcam + face mesh automatically)
  try {
    await ensureOffscreenDocument();
  } catch (err) {
    if (state.tabPort) {
      try { state.tabPort.disconnect(); } catch {}
      state.tabPort = null;
    }
    return { error: "Failed to start eye tracker: " + err.message };
  }

  state.tracking = true;
  state.statusMessage = "Starting eye tracker...";
  return { ok: true };
}

async function stopTracking() {
  state.tracking = false;
  state.statusMessage = "Stopped";

  // Notify content script
  if (state.tabPort) {
    try { state.tabPort.postMessage({ type: "stop-overlay" }); } catch {}
    try { state.tabPort.disconnect(); } catch {}
    state.tabPort = null;
  }

  // Close offscreen document (kills camera + processing)
  try { await closeOffscreenDocument(); } catch {}

  state.gazePort = null;
  state.tabId = null;
  return { ok: true };
}

// ─── Message Handler ───

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return;

  if (msg.type === "start-tracking") {
    startTracking(msg.settings || {}).then(sendResponse);
    return true;
  }

  if (msg.type === "stop-tracking") {
    stopTracking().then(sendResponse);
    return true;
  }

  if (msg.type === "get-status") {
    sendResponse({
      tracking: state.tracking,
      statusMessage: state.statusMessage,
      sensitivity: state.settings.sensitivity,
      smoothing: state.settings.smoothing
    });
    return;
  }

  if (msg.type === "update-settings") {
    state.settings = { ...state.settings, ...msg.settings };
    // Forward to content script for live updates
    if (state.tabPort) {
      try {
        state.tabPort.postMessage({
          type: "update-settings",
          settings: state.settings
        });
      } catch {}
    }
    sendResponse({ ok: true });
    return;
  }

  // Status updates from offscreen document
  if (msg.type === "status") {
    state.statusMessage = msg.message || msg.status;
    // Forward to content script for on-page badge
    if (state.tabPort) {
      try {
        state.tabPort.postMessage({
          type: "status-update",
          message: msg.message,
          status: msg.status
        });
      } catch {}
    }
    sendResponse({ ok: true });
    return;
  }
});
