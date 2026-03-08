// ─── State ───

let state = {
  tracking: false,
  tabId: null,
  tabPort: null,      // port to content script
  gazePort: null,     // port from offscreen document
  reconnecting: false,
  easyClickMode: false,
  previousZoomFactor: null,
  statusMessage: "Ready",
  settings: {
    sensitivity: 1.0,
    smoothing: 0.06
  }
};

const EASY_CLICK_ZOOM_FACTOR = 1.8;

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForContentScript(tabId, attempts = 12, intervalMs = 250) {
  for (let i = 0; i < attempts; i++) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { type: "ping" });
      if (pong?.ok) return true;
    } catch {}
    await delay(intervalMs);
  }
  return false;
}

async function connectTabPort(tabId) {
  const ready = await waitForContentScript(tabId);
  if (!ready) return { error: "Cannot connect to this page." };

  let port;
  try {
    port = chrome.tabs.connect(tabId, { name: "gaze-stream" });
  } catch (err) {
    return { error: "Failed to connect to page: " + err.message };
  }

  state.tabPort = port;
  try {
    port.postMessage({
      type: "start-overlay",
      settings: {
        ...state.settings,
        easyClickMode: state.easyClickMode
      }
    });
  } catch {}

  port.onDisconnect.addListener(() => {
    if (state.tabPort === port) {
      state.tabPort = null;
      if (state.tracking) {
        state.statusMessage = "Reconnecting to page...";
      }
    }
  });

  return { ok: true };
}

async function reconnectTrackedTab() {
  if (!state.tracking || !state.tabId || state.tabPort || state.reconnecting) return;
  state.reconnecting = true;
  state.statusMessage = "Reconnecting to page...";
  try {
    await connectTabPort(state.tabId);
    if (state.easyClickMode) {
      await applyEasyClickModeToTab(true);
    }
  } finally {
    state.reconnecting = false;
  }
}

async function applyEasyClickModeToTab(enabled) {
  if (!state.tabId) return { error: "No active tracked tab" };

  if (enabled) {
    if (state.previousZoomFactor == null) {
      try {
        state.previousZoomFactor = await chrome.tabs.getZoom(state.tabId);
      } catch {
        state.previousZoomFactor = 1;
      }
    }
    await chrome.tabs.setZoom(state.tabId, EASY_CLICK_ZOOM_FACTOR);
  } else {
    const restoreZoom = state.previousZoomFactor == null ? 1 : state.previousZoomFactor;
    try {
      await chrome.tabs.setZoom(state.tabId, restoreZoom);
    } catch {}
    state.previousZoomFactor = null;
  }

  if (state.tabPort) {
    try {
      state.tabPort.postMessage({ type: "set-easy-click-mode", enabled });
    } catch {}
  }

  state.easyClickMode = enabled;
  return { ok: true, enabled: state.easyClickMode };
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

  state.tabId = tab.id;
  state.settings = { ...state.settings, ...settings };

  const portResult = await connectTabPort(tab.id);
  if (portResult.error) return portResult;

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
  if (state.easyClickMode) {
    await applyEasyClickModeToTab(false);
  }

  state.tracking = false;
  state.reconnecting = false;
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!state.tracking || tabId !== state.tabId) return;
  if (changeInfo.status === "complete") {
    reconnectTrackedTab().catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (!state.tracking) return;
  if (activeInfo.tabId === state.tabId) return;

  // Clean up old tab
  if (state.tabPort) {
    try { state.tabPort.postMessage({ type: "stop-overlay" }); } catch {}
    try { state.tabPort.disconnect(); } catch {}
    state.tabPort = null;
  }

  // Switch to the new tab
  state.tabId = activeInfo.tabId;
  try {
    await connectTabPort(activeInfo.tabId);
    if (state.easyClickMode) {
      await applyEasyClickModeToTab(true);
    }
  } catch {}
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!state.tracking || tabId !== state.tabId) return;
  // Clear the closed tab's port but keep tracking active.
  // onActivated will reconnect to whichever tab becomes active next.
  if (state.tabPort) {
    try { state.tabPort.disconnect(); } catch {}
    state.tabPort = null;
  }
  state.tabId = null;
});

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
      easyClickMode: state.easyClickMode,
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

  if (msg.type === "toggle-easy-click-mode") {
    if (!state.tracking || !state.tabPort || !state.tabId) {
      sendResponse({ error: "Tracking is not active" });
      return;
    }

    applyEasyClickModeToTab(!state.easyClickMode)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ error: "Failed to toggle Easy Click Mode: " + err.message });
      });
    return true;
  }

  if (msg.type === "calibrate-center") {
    if (!state.tracking || !state.tabPort) {
      sendResponse({ error: "Tracking is not active" });
      return;
    }
    try {
      state.tabPort.postMessage({ type: "calibrate-center" });
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ error: "Failed to send calibrate command: " + err.message });
    }
    return;
  }

  // Status updates from offscreen document
  if (msg.type === "status") {
    state.statusMessage = msg.message || msg.status;

    if (msg.status === "error") {
      if (state.easyClickMode) {
        applyEasyClickModeToTab(false).catch(() => {});
      }
      state.tracking = false;

      // If startup failed, ensure page overlay and ports are cleaned up.
      if (state.tabPort) {
        try { state.tabPort.postMessage({ type: "stop-overlay" }); } catch {}
        try { state.tabPort.disconnect(); } catch {}
        state.tabPort = null;
      }
      state.gazePort = null;
      state.tabId = null;

      // Best-effort cleanup of offscreen document.
      closeOffscreenDocument().catch(() => {});
    }

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
