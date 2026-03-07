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
  let biasX = 0;
  let biasY = 0;
  let lastHorizontal = 0;
  let lastVertical = 0;

  // Settings (updated from popup via service worker)
  let sensitivity = 2.0;
  let smoothingFactor = 0.1;
  const BLINK_COOLDOWN_MS = 600;
  const MAX_DYNAMIC_SMOOTHING = 0.32;
  const SPEED_FOR_MAX_SMOOTHING_X = 140;
  const SPEED_FOR_MAX_SMOOTHING_Y = 80;
  const AXIS_X = {
    range: 0.32,
    deadzone: 0.08,
    responseExponent: 1.35,
    gain: 1.0,
    biasLearnRate: 0.015,
    biasLearnThreshold: 0.2,
    biasMax: 0.12
  };
  const AXIS_Y = {
    range: 0.22,
    deadzone: 0.03,
    responseExponent: 1.1,
    gain: 1.35,
    biasLearnRate: 0.006,
    biasLearnThreshold: 0.1,
    biasMax: 0.08
  };

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

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function applyDeadzone(v, deadzone) {
    const abs = Math.abs(v);
    if (abs <= deadzone) return 0;
    return Math.sign(v) * ((abs - deadzone) / (1 - deadzone));
  }

  function shapeResponse(v, exponent) {
    return Math.sign(v) * Math.pow(Math.abs(v), exponent);
  }

  function learnBias(horizontal, vertical) {
    // Learn neutral gaze center only when gaze is near center to avoid drift.
    if (Math.abs(horizontal - biasX) < AXIS_X.biasLearnThreshold) {
      biasX = clamp(
        biasX + (horizontal - biasX) * AXIS_X.biasLearnRate,
        -AXIS_X.biasMax,
        AXIS_X.biasMax
      );
    }
    if (Math.abs(vertical - biasY) < AXIS_Y.biasLearnThreshold) {
      biasY = clamp(
        biasY + (vertical - biasY) * AXIS_Y.biasLearnRate,
        -AXIS_Y.biasMax,
        AXIS_Y.biasMax
      );
    }
  }

  function mapAxis(raw, bias, axisConfig) {
    const corrected = raw - bias;
    let normalized = clamp(corrected / axisConfig.range, -1, 1);
    normalized = applyDeadzone(normalized, axisConfig.deadzone);
    normalized = shapeResponse(normalized, axisConfig.responseExponent);
    normalized *= axisConfig.gain;
    normalized = clamp(normalized, -1, 1);
    return normalized;
  }

  function updateGaze(horizontal, vertical) {
    const mappedX = mapAxis(horizontal, biasX, AXIS_X);
    const mappedY = mapAxis(vertical, biasY, AXIS_Y);

    const rawX = (0.5 + mappedX * 0.5 * sensitivity) * window.innerWidth;
    const rawY = (0.5 + mappedY * 0.5 * sensitivity) * window.innerHeight;

    // Clamp to viewport
    const clampedX = clamp(rawX, 0, window.innerWidth);
    const clampedY = clamp(rawY, 0, window.innerHeight);

    // Adaptive smoothing: stable when fixating, faster when moving gaze.
    const dx = clampedX - smoothX;
    const dy = clampedY - smoothY;
    const dynamicX = clamp(Math.abs(dx) / SPEED_FOR_MAX_SMOOTHING_X, 0, 1);
    const dynamicY = clamp(Math.abs(dy) / SPEED_FOR_MAX_SMOOTHING_Y, 0, 1);
    const alphaX = clamp(
      smoothingFactor + (MAX_DYNAMIC_SMOOTHING - smoothingFactor) * dynamicX,
      smoothingFactor,
      MAX_DYNAMIC_SMOOTHING
    );
    const alphaY = clamp(
      smoothingFactor + (MAX_DYNAMIC_SMOOTHING - smoothingFactor) * dynamicY,
      smoothingFactor,
      MAX_DYNAMIC_SMOOTHING
    );

    smoothX += dx * alphaX;
    smoothY += dy * alphaY;

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

  function findClickableNear(x, y, radius = 60) {
    const points = [
      [0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius],
      [radius * 0.7, radius * 0.7], [radius * 0.7, -radius * 0.7],
      [-radius * 0.7, radius * 0.7], [-radius * 0.7, -radius * 0.7]
    ];

    let best = null;
    let bestDist = Infinity;

    for (const [ox, oy] of points) {
      const px = clamp(x + ox, 0, window.innerWidth - 1);
      const py = clamp(y + oy, 0, window.innerHeight - 1);
      const candidate = findClickableElement(px, py);
      if (!candidate) continue;

      const rect = candidate.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = Math.hypot(cx - x, cy - y);

      if (dist < bestDist) {
        bestDist = dist;
        best = candidate;
      }
    }

    return bestDist <= radius * 1.4 ? best : null;
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

    const target = findClickableNear(cursorX, cursorY, 70) || findClickableElement(cursorX, cursorY);
    if (target) {
      simulateClick(target);
      setStatusText("Clicked!");
      setTimeout(() => {
        if (isActive) setStatusText("Tracking");
      }, 800);
    }
  }

  function calibrateCenter() {
    biasX = clamp(lastHorizontal, -AXIS_X.biasMax, AXIS_X.biasMax);
    biasY = clamp(lastVertical, -AXIS_Y.biasMax, AXIS_Y.biasMax);
    setStatusText("Center calibrated");
    setTimeout(() => {
      if (isActive) setStatusText("Tracking");
    }, 800);
  }

  // ─── Start / Stop ───

  function startOverlay(settings) {
    if (isActive) return;
    isActive = true;

    if (settings) {
      sensitivity = settings.sensitivity || 2.0;
      smoothingFactor = settings.smoothing || 0.1;
    }

    // Reset cursor to center
    smoothX = window.innerWidth / 2;
    smoothY = window.innerHeight / 2;
    cursorX = smoothX;
    cursorY = smoothY;
    biasX = 0;
    biasY = 0;

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

        case "calibrate-center":
          calibrateCenter();
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
          lastHorizontal = msg.horizontal;
          lastVertical = msg.vertical;
          // Keep cursor stable while eyes are closed to avoid blink-induced jumps.
          if (!msg.eyesClosed) {
            learnBias(msg.horizontal, msg.vertical);
            updateGaze(msg.horizontal, msg.vertical);
          }

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
