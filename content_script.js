(function () {
  // Prevent double injection
  if (window.__eyesOnlyInjected) return;
  window.__eyesOnlyInjected = true;

  // ─── State ───

  let isActive = false;
  let cursorEl = null;
  let statusEl = null;
  let cursorX = window.innerWidth / 2;
  let cursorY = window.innerHeight / 2;
  let smoothX = cursorX;
  let smoothY = cursorY;
  let lastBlinkTime = 0;

  // Settings (updated from popup via service worker)
  let sensitivity = 2.5;
  let smoothingFactor = 0.15;
  const BLINK_COOLDOWN_MS = 600;

  // ─── Cursor Overlay ───

  function createCursor() {
    if (cursorEl) return;

    cursorEl = document.createElement("div");
    cursorEl.id = "__eyes_only_cursor__";
    cursorEl.style.cssText = [
      "position: fixed",
      "top: 0",
      "left: 0",
      "width: 30px",
      "height: 30px",
      "border-radius: 50%",
      "background: rgba(59, 130, 246, 0.4)",
      "border: 3px solid rgba(59, 130, 246, 0.9)",
      "pointer-events: none",
      "z-index: 2147483647",
      "transform: translate(-50%, -50%)",
      "box-shadow: 0 0 12px rgba(59, 130, 246, 0.5)",
      "transition: background 0.15s, transform 0.15s"
    ].join(";");
    document.documentElement.appendChild(cursorEl);
    moveCursor(smoothX, smoothY);
  }

  function removeCursor() {
    if (cursorEl) {
      cursorEl.remove();
      cursorEl = null;
    }
  }

  function moveCursor(x, y) {
    if (!cursorEl) return;
    cursorEl.style.left = x + "px";
    cursorEl.style.top = y + "px";
  }

  // ─── Status Badge ───

  function createStatusBadge() {
    if (statusEl) return;

    statusEl = document.createElement("div");
    statusEl.id = "__eyes_only_status__";
    statusEl.style.cssText = [
      "position: fixed",
      "bottom: 12px",
      "right: 12px",
      "padding: 6px 14px",
      "background: rgba(0, 0, 0, 0.8)",
      "color: #4fc3f7",
      "font-size: 12px",
      "font-family: system-ui, -apple-system, sans-serif",
      "border-radius: 20px",
      "z-index: 2147483647",
      "pointer-events: none",
      "backdrop-filter: blur(4px)"
    ].join(";");
    statusEl.textContent = "Eyes Only: Starting...";
    document.documentElement.appendChild(statusEl);
  }

  function removeStatusBadge() {
    if (statusEl) {
      statusEl.remove();
      statusEl = null;
    }
  }

  function setStatusText(text) {
    if (statusEl) statusEl.textContent = "Eyes Only: " + text;
  }

  // ─── Gaze to Screen Mapping ───
  // horizontal/vertical from blendshapes are roughly -0.3 to +0.3.
  // Sensitivity scales this range to cover the viewport.

  function updateGaze(horizontal, vertical) {
    const rawX = (0.5 + horizontal * sensitivity) * window.innerWidth;
    const rawY = (0.5 + vertical * sensitivity) * window.innerHeight;

    // Clamp to viewport
    const clampedX = Math.max(0, Math.min(window.innerWidth, rawX));
    const clampedY = Math.max(0, Math.min(window.innerHeight, rawY));

    // Exponential moving average smoothing
    smoothX += (clampedX - smoothX) * smoothingFactor;
    smoothY += (clampedY - smoothY) * smoothingFactor;

    cursorX = smoothX;
    cursorY = smoothY;
    moveCursor(cursorX, cursorY);
  }

  // ─── Click Targeting ───
  // Walk up the DOM tree to find a clickable ancestor if the element
  // directly under the cursor is not interactive.

  const CLICKABLE_TAGS = new Set([
    "A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "SUMMARY", "DETAILS"
  ]);

  const CLICKABLE_ROLES = new Set([
    "button", "link", "menuitem", "tab", "checkbox", "radio", "option", "switch"
  ]);

  function findClickableElement(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;

    let current = el;
    while (current && current !== document.body && current !== document.documentElement) {
      if (CLICKABLE_TAGS.has(current.tagName)) return current;
      const role = current.getAttribute("role");
      if (role && CLICKABLE_ROLES.has(role)) return current;
      if (current.onclick || current.hasAttribute("onclick")) return current;
      current = current.parentElement;
    }

    // Fallback: return the original element
    return el;
  }

  function simulateClick(el) {
    if (!el) return;

    // Focus if applicable
    if (typeof el.focus === "function") {
      try { el.focus(); } catch {}
    }

    // Full mouse event sequence for maximum compatibility
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: cx,
      clientY: cy
    };

    el.dispatchEvent(new MouseEvent("mousedown", eventInit));
    el.dispatchEvent(new MouseEvent("mouseup", eventInit));
    el.dispatchEvent(new MouseEvent("click", eventInit));
  }

  // ─── Blink Click Handler ───

  function handleBlink() {
    const now = Date.now();
    if (now - lastBlinkTime < BLINK_COOLDOWN_MS) return;
    lastBlinkTime = now;

    // Visual feedback: pulse the cursor green
    if (cursorEl) {
      cursorEl.style.background = "rgba(76, 175, 80, 0.7)";
      cursorEl.style.transform = "translate(-50%, -50%) scale(1.5)";
      setTimeout(() => {
        if (cursorEl) {
          cursorEl.style.background = "rgba(59, 130, 246, 0.4)";
          cursorEl.style.transform = "translate(-50%, -50%) scale(1)";
        }
      }, 200);
    }

    const target = findClickableElement(cursorX, cursorY);
    if (target) {
      simulateClick(target);
      setStatusText("Clicked!");
      setTimeout(() => {
        if (isActive) setStatusText("Tracking");
      }, 800);
    }
  }

  // ─── Start / Stop ───

  function startOverlay(settings) {
    if (isActive) return;
    isActive = true;

    if (settings) {
      sensitivity = settings.sensitivity || 2.5;
      smoothingFactor = settings.smoothing || 0.15;
    }

    // Reset cursor to center
    smoothX = window.innerWidth / 2;
    smoothY = window.innerHeight / 2;
    cursorX = smoothX;
    cursorY = smoothY;

    createCursor();
    createStatusBadge();
    setStatusText("Starting...");
  }

  function stopOverlay() {
    isActive = false;
    removeCursor();
    removeStatusBadge();
  }

  // ─── Message Handling ───

  // Ping handler for connectivity check (uses one-shot messages)
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "ping") {
      sendResponse({ ok: true });
    }
  });

  // Port-based streaming from service worker
  chrome.runtime.onConnect.addListener((incomingPort) => {
    if (incomingPort.name !== "gaze-stream") return;

    incomingPort.onMessage.addListener((msg) => {
      if (!msg?.type) return;

      switch (msg.type) {
        case "start-overlay":
          startOverlay(msg.settings);
          break;

        case "stop-overlay":
          stopOverlay();
          break;

        case "update-settings":
          if (msg.settings) {
            if (msg.settings.sensitivity != null) sensitivity = msg.settings.sensitivity;
            if (msg.settings.smoothing != null) smoothingFactor = msg.settings.smoothing;
          }
          break;

        case "status-update":
          setStatusText(msg.message || msg.status || "");
          break;

        case "gaze-data":
          if (!isActive) break;

          if (!msg.faceDetected) {
            setStatusText("No face detected");
            break;
          }

          setStatusText("Tracking");
          updateGaze(msg.horizontal, msg.vertical);

          if (msg.blink) {
            handleBlink();
          }
          break;
      }
    });

    incomingPort.onDisconnect.addListener(() => {
      stopOverlay();
    });
  });
})();
